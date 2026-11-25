// Event Processor (doc 05 §5/§8/§9): turns captured browser events into
// either an expected-mutation match (remote origin → mirror only, no local
// op) or a local user operation (mirror + pending op in ONE transaction).
// Event capture never pauses (doc 05 §13 / doc 22 B.12).

import type { BrowserAdapter, BrowserEvent, BrowserNode } from '../browser/types';
import {
  activeReconSession,
  collectSubtree,
  logDiagnostic,
  type BindingRecord,
  type BindingState,
  type LocalNodeRecord,
  type PontisDB,
  type PendingOpRecord,
  type PendingStatus,
} from '../store/db';
import type { OpType, ParentRefWire } from '../protocol/types';
import { uuidv7 } from '../util/ids';
import { pruneExpiredStepExpectations } from './reconcileSteps';

export type EventDisposition = 'expected' | 'local-op' | 'ignored';

/** One operation to queue behind a create that is already on its way. */
interface OpRow {
  type: OpType;
  title?: string;
  url?: string;
  parent?: ParentRefWire;
  beforeId?: string | null;
}

/**
 * The binding states whose browser events are still captured (doc 05 §13).
 * Recovery pauses what a device *sends* — the coordinator gates that on its
 * own — but never what a person does. A move or a delete that is not recorded
 * here is invisible to every later scan: the browser and the mirror both lack
 * it, and comparing those two finds nothing wrong.
 */
const CAPTURING_STATES: readonly BindingState[] = [
  'active',
  'initializing',
  'resyncing',
  'needs_recovery',
  'waiting_user',
];

export function capturesBindingEvents(state: BindingState): boolean {
  return CAPTURING_STATES.includes(state);
}

export class EventProcessor {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
  ) {}

  async handleEvent(bindingId: string, event: BrowserEvent): Promise<EventDisposition> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || !capturesBindingEvents(binding.state)) {
      return 'ignored';
    }
    // Prune stale reconciliation step expectations so unconsumed echoes cannot
    // swallow future user edits forever (R37).
    await pruneExpiredStepExpectations(this.db, binding.id);
    switch (event.kind) {
      case 'created':
        return this.handleCreated(binding, event.node);
      case 'changed':
        return this.handleChanged(binding, event.node);
      case 'moved':
        return this.handleMoved(binding, event.node, event.oldParentId);
      case 'removed':
        return this.handleRemoved(binding, event.node);
    }
  }

  // --- created ---

  private async handleCreated(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    if (node.parentId == null || !(await this.isManagedScope(binding, node.parentId))) {
      return 'ignored';
    }

    // Expected remote mutation? Provisional create expectations are
    // resolved by the browser event carrying the new browser id.
    const provisional = await this.db.expectedMutations
      .where('[bindingId+kind]')
      .equals([binding.id, 'create'])
      .filter(
        (e) =>
          e.browserId == null &&
          e.parentBrowserId === node.parentId &&
          e.title === node.title &&
          (e.url ?? null) === node.url,
      )
      .toArray();
    if (provisional.length === 1) {
      const exp = provisional[0]!;
      await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
        await this.db.expectedMutations.delete(exp.id!);
        if (!exp.canonicalId.startsWith('__recovery_root__:')) {
          await this.db.localNodes.put({
            bindingId: binding.id,
            browserId: node.id,
            canonicalId: exp.canonicalId,
            type: node.type,
            title: node.title,
            url: node.url,
            parentBrowserId: node.parentId,
            position: exp.position ?? null,
          });
        }
      });
      return 'expected';
    }
    if (provisional.length > 1) {
      // Ambiguity: never guess (doc 05 §9) — leave it to reconciliation.
      await logDiagnostic(this.db, 'warn', 'event-processor', '新建预期有歧义，已跳过', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }

    // A create the applier already resolved to this browser id: the mirror is
    // written, only the expectation is still waiting for this echo. Consuming
    // it here is what keeps a sync-created bookmark from being uploaded as if
    // the user had just made it.
    const settled = await this.db.expectedMutations
      .where('[bindingId+kind]')
      .equals([binding.id, 'create'])
      .filter((e) => e.browserId === node.id)
      .toArray();
    if (settled.length > 0) {
      await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
        await this.db.expectedMutations.bulkDelete(settled.map((e) => e.id!));
        if (
          !settled[0]!.canonicalId.startsWith('__recovery_root__:') &&
          !(await this.db.localNodes.get([binding.id, node.id]))
        ) {
          await this.db.localNodes.put({
            bindingId: binding.id,
            browserId: node.id,
            canonicalId: settled[0]!.canonicalId,
            type: node.type,
            title: node.title,
            url: node.url,
            parentBrowserId: node.parentId,
            position: null,
          });
        }
      });
      return 'expected';
    }

    const parentRef = await this.canonicalParentRef(binding, node.parentId);
    if (!parentRef) {
      if (await this.markReconDirtyIfActive(binding, node.id)) {
        return 'local-op';
      }
      await logDiagnostic(this.db, 'warn', 'event-processor', '本机新建位于未映射的父目录下，已跳过', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }
    const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);

    // Rule 1 (doc 05 §16): mirror + pending op share one IDB transaction.
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.localNodes.put({
        bindingId: b.id,
        browserId: node.id,
        canonicalId: null,
        type: node.type,
        title: node.title,
        url: node.url,
        parentBrowserId: node.parentId,
        position: null,
      });
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'create',
        // The client names its own node (doc 04): this id is what the ack and
        // the change stream come back with, so the browser node is mapped to
        // the canonical node it produced instead of being re-created.
        nodeId: uuidv7(),
        nodeType: node.type,
        title: node.title,
        url: node.url ?? undefined,
        parent: parentRef,
        beforeId,
        browserId: node.id,
        createdAt: Date.now(),
      });
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- changed ---

  private async handleChanged(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    if (!(await this.isManagedScope(binding, node.id))) return 'ignored';
    const mirror = await this.db.localNodes.get([binding.id, node.id]);

    // Expected title/url mutation match (doc 05 §8).
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations.where('bindingId').equals(binding.id).toArray();
      const matches = expectations.filter(
        (e) =>
          e.browserId === node.id &&
          e.canonicalId === mirror.canonicalId &&
          ((e.kind === 'update_title' && e.title === node.title) ||
            (e.kind === 'update_url' && (e.url ?? null) === node.url)),
      );
      if (matches.length > 0) {
        await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
          await this.db.expectedMutations.bulkDelete(matches.map((e) => e.id!));
          await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
        });
        return 'expected';
      }
    }

    if (!mirror) {
      if (await this.markReconDirtyIfActive(binding, node.id)) {
        return 'local-op';
      }
      return 'ignored';
    }

    // The node has no canonical id yet, so the outbox create is the only thing
    // that carries it forward.
    if (mirror.canonicalId == null) {
      const queuedCreate = await this.findCreate(binding.id, node.id, 'QUEUED');
      if (queuedCreate) {
        // Never sent, so the edit belongs in the same operation.
        await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
          queuedCreate.title = node.title;
          queuedCreate.url = node.url ?? undefined;
          await this.db.pendingOps.put(queuedCreate);
          await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
        });
        return 'local-op';
      }
      const sentCreate = await this.findCreate(binding.id, node.id, 'IN_FLIGHT');
      if (sentCreate) {
        // Its payload has already left the device and is frozen — a retry of a
        // mutated body is refused as OP_ID_REUSED (doc 04). The edit goes out
        // as its own operation, addressed by the canonical id this device named
        // for the node in the create.
        const updates: OpRow[] = [];
        if (node.title !== sentCreate.title) updates.push({ type: 'update_title', title: node.title });
        if ((node.url ?? '') !== (sentCreate.url ?? '')) updates.push({ type: 'update_url', url: node.url ?? '' });
        if (updates.length === 0) {
          await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
          return 'ignored';
        }
        await this.queueFollowUp(binding, sentCreate.nodeId, updates, () =>
          this.db.localNodes.put({ ...mirror, title: node.title, url: node.url }),
        );
        return 'local-op';
      }
      await logDiagnostic(this.db, 'warn', 'event-processor', '未映射本机节点的改动已丢弃', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }

    // One field per operation (doc 22 A). Diff against the mirror so we
    // never re-send a value the server already has.
    const updates: Array<{ type: 'update_title' | 'update_url'; title?: string; url?: string }> = [];
    if (node.title !== mirror.title) updates.push({ type: 'update_title', title: node.title });
    if ((node.url ?? null) !== mirror.url) updates.push({ type: 'update_url', url: node.url ?? '' });
    if (updates.length === 0) return 'ignored';

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      for (const u of updates) {
        b.clientSeq += 1;
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId: b.id,
          clientSeq: b.clientSeq,
          baseRevision: b.appliedRevision,
          status: 'QUEUED',
          type: u.type,
          nodeId: mirror.canonicalId!,
          title: u.title,
          url: u.url,
          createdAt: Date.now(),
        });
      }
      await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- moved ---

  private async handleMoved(
    binding: BindingRecord,
    node: BrowserNode,
    oldParentId: string | null,
  ): Promise<EventDisposition> {
    if (node.parentId == null) return 'ignored';
    const mirror = await this.db.localNodes.get([binding.id, node.id]);
    const nowInScope = await this.isManagedScope(binding, node.parentId);
    const wasInScope =
      mirror != null || (oldParentId != null && (await this.isManagedScope(binding, oldParentId)));

    if (!wasInScope && !nowInScope) return 'ignored';

    // Expected move (doc 05 §8): match on canonical id + target parent.
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations
        .where('[bindingId+kind]')
        .equals([binding.id, 'move'])
        .filter((e) => e.canonicalId === mirror.canonicalId && e.parentBrowserId === node.parentId)
        .toArray();
      if (expectations.length === 1) {
        // Mirror update is the applier's job; only consume the expectation
        // (deleting here is idempotent with the applier's own cleanup).
        await this.db.expectedMutations.delete(expectations[0]!.id!);
        return 'expected';
      }
    }

    // R17 Case 1: Dragged IN from outside this binding's scope (e.g. from an
    // unmanaged browser folder into a partial sync mount). If the node came
    // from another active binding, that binding owns the atomic cross-space
    // transfer (doc 03 §7), so we must not duplicate it as a create here.
    if (!wasInScope && nowInScope) {
      if (await this.ownedByOtherBinding(binding.id, node.id, oldParentId)) {
        return 'ignored';
      }
      const parentRef = await this.canonicalParentRef(binding, node.parentId);
      if (!parentRef) {
        if (await this.markReconDirtyIfActive(binding, node.id)) return 'local-op';
        await logDiagnostic(this.db, 'warn', 'event-processor', '拖入节点目标父目录未映射，已跳过', {
          bindingId: binding.id,
          node,
        });
        return 'ignored';
      }
      return this.enqueueDraggedInSubtree(binding, node, parentRef);
    }

    // R17 Case 2: Dragged OUT of this binding's scope.
    if (wasInScope && !nowInScope) {
      if (!mirror) {
        if (await this.markReconDirtyIfActive(binding, node.id)) return 'local-op';
        return 'ignored';
      }
      if (mirror.canonicalId == null) {
        // Unsettled local create dragged out of the synced folder: treat like a
        // local removal from this binding's scope.
        const queuedCreate = await this.findCreate(binding.id, node.id, 'QUEUED');
        if (queuedCreate) {
          await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
            await this.db.pendingOps.delete(queuedCreate.opId);
            await this.deleteMirrorSubtree(binding.id, node.id);
          });
          return 'ignored';
        }
        const sentCreate = await this.findCreate(binding.id, node.id, 'IN_FLIGHT');
        if (sentCreate) {
          await this.queueFollowUp(binding, sentCreate.nodeId, [{ type: 'delete' }], () =>
            this.deleteMirrorSubtree(binding.id, node.id),
          );
          return 'local-op';
        }
        await this.deleteMirrorSubtree(binding.id, node.id);
        return 'ignored';
      }

      // Cross-space drag (doc 03 §7): moved into another active binding's mount.
      const cross = await this.crossBindingTarget(binding, node.parentId);
      if (cross) {
        await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps], async () => {
          const b = await this.db.bindings.get(binding.id);
          if (!b) return;
          const clientSeq = b.clientSeq + 1;
          await this.db.pendingOps.add({
            opId: uuidv7(),
            bindingId: b.id,
            clientSeq,
            baseRevision: b.appliedRevision,
            status: 'QUEUED',
            type: 'transfer',
            nodeId: mirror.canonicalId!,
            targetSpaceId: cross.binding.spaceId,
            targetParent: cross.parentRef,
            browserId: node.id,
            browserParentId: node.parentId ?? undefined,
            createdAt: Date.now(),
          });
          b.clientSeq = clientSeq;
          await this.db.bindings.put(b);
        });
        return 'local-op';
      }

      // Moved to an unmanaged folder outside all bindings: delete from this space
      // while leaving the bookmark intact in its new browser folder (R17).
      await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
        const b = await this.db.bindings.get(binding.id);
        if (!b) return;
        const clientSeq = b.clientSeq + 1;
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId: b.id,
          clientSeq,
          baseRevision: b.appliedRevision,
          status: 'QUEUED',
          type: 'delete',
          nodeId: mirror.canonicalId!,
          browserId: node.id,
          createdAt: Date.now(),
        });
        await this.deleteMirrorSubtree(binding.id, node.id);
        b.clientSeq = clientSeq;
        await this.db.bindings.put(b);
      });
      return 'local-op';
    }

    if (!mirror) {
      if (await this.markReconDirtyIfActive(binding, node.id)) {
        return 'local-op';
      }
      return 'ignored';
    }

    // The node has no canonical id yet; the outbox create carries it.
    if (mirror.canonicalId == null) {
      const parentRef = await this.canonicalParentRef(binding, node.parentId!);
      if (!parentRef) return 'ignored';
      const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);
      const queuedCreate = await this.findCreate(binding.id, node.id, 'QUEUED');
      if (queuedCreate?.parent) {
        // Never sent: retarget it in place.
        await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
          queuedCreate.parent = parentRef;
          queuedCreate.beforeId = beforeId;
          await this.db.pendingOps.put(queuedCreate);
          await this.db.localNodes.put({ ...mirror, parentBrowserId: node.parentId, position: null });
        });
        return 'local-op';
      }
      const sentCreate = await this.findCreate(binding.id, node.id, 'IN_FLIGHT');
      if (sentCreate) {
        // Sent already, so the placement it carries is frozen; the move is its
        // own operation against the id the create named (doc 04).
        await this.queueFollowUp(binding, sentCreate.nodeId, [{ type: 'move', parent: parentRef, beforeId }], () =>
          this.db.localNodes.put({ ...mirror, parentBrowserId: node.parentId, position: null }),
        );
        return 'local-op';
      }
      return 'ignored';
    }

    const parentRef = await this.canonicalParentRef(binding, node.parentId);
    if (!parentRef) {
      await logDiagnostic(this.db, 'warn', 'event-processor', '本机移动到未映射的父目录，已跳过', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }
    const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'move',
        nodeId: mirror.canonicalId!,
        parent: parentRef,
        beforeId,
        browserId: node.id,
        createdAt: Date.now(),
      });
      await this.db.localNodes.put({ ...mirror, parentBrowserId: node.parentId, position: null });
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  /**
   * Queue top-down CREATE ops and provisional mirrors for a node (and its whole
   * folder subtree, if any) dragged from an unmanaged browser folder into this
   * binding's scope (R17).
   */
  private async enqueueDraggedInSubtree(
    binding: BindingRecord,
    rootNode: BrowserNode,
    rootParentRef: ParentRefWire,
  ): Promise<EventDisposition> {
    const rootBeforeId = rootNode.parentId
      ? await this.nextSiblingCanonicalId(binding, rootNode.parentId, rootNode.index)
      : null;

    // Collect the entire subtree from the browser BEFORE opening the Dexie tx.
    const entries: Array<{
      node: BrowserNode;
      canonicalId: string;
      parentRef: ParentRefWire;
      beforeId: string | null;
    }> = [];
    const rootCanonicalId = uuidv7();
    entries.push({ node: rootNode, canonicalId: rootCanonicalId, parentRef: rootParentRef, beforeId: rootBeforeId });

    const queue: Array<{ browserId: string; canonicalId: string }> =
      rootNode.type === 'folder' ? [{ browserId: rootNode.id, canonicalId: rootCanonicalId }] : [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const children = await this.adapter.getChildren(cur.browserId);
      for (const child of children) {
        const childCanonicalId = uuidv7();
        entries.push({
          node: child,
          canonicalId: childCanonicalId,
          parentRef: { type: 'node', id: cur.canonicalId },
          beforeId: null,
        });
        if (child.type === 'folder') {
          queue.push({ browserId: child.id, canonicalId: childCanonicalId });
        }
      }
    }

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      for (const item of entries) {
        b.clientSeq += 1;
        await this.db.localNodes.put({
          bindingId: b.id,
          browserId: item.node.id,
          canonicalId: null,
          type: item.node.type,
          title: item.node.title,
          url: item.node.url,
          parentBrowserId: item.node.parentId,
          position: null,
        });
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId: b.id,
          clientSeq: b.clientSeq,
          baseRevision: b.appliedRevision,
          status: 'QUEUED',
          type: 'create',
          nodeId: item.canonicalId,
          nodeType: item.node.type,
          title: item.node.title,
          url: item.node.url ?? undefined,
          parent: item.parentRef,
          beforeId: item.beforeId,
          browserId: item.node.id,
          createdAt: Date.now(),
        });
      }
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  /** True if another active binding already owns this node or its previous parent. */
  private async ownedByOtherBinding(
    bindingId: string,
    browserId: string,
    oldParentId: string | null,
  ): Promise<boolean> {
    const others = await this.db.bindings.where('state').equals('active').toArray();
    for (const other of others) {
      if (other.id === bindingId) continue;
      if (await this.db.localNodes.get([other.id, browserId])) return true;
      if (oldParentId && (await this.isManagedScope(other, oldParentId))) return true;
    }
    return false;
  }

  // --- removed ---

  private async handleRemoved(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    // Mount root deletion is not a canonical DELETE (doc 03 §5).
    if (binding.mount.mode === 'partial' && node.id === binding.mount.folderBrowserId) {
      await this.db.bindings.update(binding.id, { state: 'mount_missing' });
      await logDiagnostic(this.db, 'warn', 'event-processor', '挂载根目录被删除，绑定已暂停（缺少挂载目录）', {
        bindingId: binding.id,
      });
      return 'ignored';
    }
    if (binding.mount.mode === 'full' && binding.mount.roots) {
      if (Object.values(binding.mount.roots).includes(node.id)) {
        await this.db.bindings.update(binding.id, { state: 'mount_missing' });
        return 'ignored';
      }
    }
    if (!(await this.isManagedScope(binding, node.id, node.parentId))) return 'ignored';

    const mirror = await this.db.localNodes.get([binding.id, node.id]);

    // Expected delete (doc 05 §8).
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations
        .where('[bindingId+kind]')
        .equals([binding.id, 'delete'])
        .filter((e) => e.browserId === node.id)
        .toArray();
      if (expectations.length === 1) {
        await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
          await this.db.expectedMutations.delete(expectations[0]!.id!);
          await this.deleteMirrorSubtree(binding.id, node.id);
        });
        return 'expected';
      }
    }

    if (!mirror) {
      if (await this.markReconDirtyIfActive(binding, node.id)) {
        return 'local-op';
      }
      return 'ignored';
    }

    // The node has no canonical id yet; the outbox create is what carries it.
    if (mirror.canonicalId == null) {
      const queuedCreate = await this.findCreate(binding.id, node.id, 'QUEUED');
      if (queuedCreate) {
        // Never sent, and nothing server-side to remove: the intent and its
        // mirrors go together.
        await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
          await this.db.pendingOps.delete(queuedCreate.opId);
          await this.deleteMirrorSubtree(binding.id, node.id);
        });
        return 'ignored';
      }
      const sentCreate = await this.findCreate(binding.id, node.id, 'IN_FLIGHT');
      if (sentCreate) {
        // The create is already the server's to answer for and cannot be taken
        // back, so the deletion is its own operation against the id the create
        // named. The browser shows the node again for one round — the create
        //回流 has nothing to adopt — and loses it when this op is applied.
        await this.queueFollowUp(binding, sentCreate.nodeId, [{ type: 'delete' }], () =>
          this.deleteMirrorSubtree(binding.id, node.id),
        );
        return 'local-op';
      }
      return 'ignored';
    }

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'delete',
        nodeId: mirror.canonicalId!,
        browserId: node.id,
        createdAt: Date.now(),
      });
      await this.deleteMirrorSubtree(binding.id, node.id);
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- helpers ---

  /** The create carrying this browser node, in one outbox state or none. */
  private async findCreate(
    bindingId: string,
    browserId: string,
    status: PendingStatus,
  ): Promise<PendingOpRecord | undefined> {
    return this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, status])
      .filter((o) => o.browserId === browserId && o.type === 'create')
      .first();
  }

  /**
   * Queue operations that follow a create already on its way to the server,
   * addressed by the canonical id that create named (doc 04: the client
   * allocates it, so the node is addressable before the ack). They take the
   * next client_seq values and so are applied after it. Mirror bookkeeping
   * happens in the same transaction (doc 05 §16 rule 1).
   */
  private async queueFollowUp(
    binding: BindingRecord,
    canonicalId: string,
    ops: OpRow[],
    writeMirror: () => Promise<unknown>,
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      for (const o of ops) {
        b.clientSeq += 1;
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId: b.id,
          clientSeq: b.clientSeq,
          baseRevision: b.appliedRevision,
          status: 'QUEUED',
          type: o.type,
          nodeId: canonicalId,
          title: o.title,
          url: o.url,
          parent: o.parent,
          beforeId: o.beforeId ?? null,
          createdAt: Date.now(),
        });
      }
      await writeMirror();
      await this.db.bindings.put(b);
    });
  }

  private async deleteMirrorSubtree(bindingId: string, browserId: string): Promise<void> {
    const subtree = await collectSubtree(this.db, bindingId, browserId);
    await this.db.localNodes.bulkDelete(subtree.map((r) => [bindingId, r.browserId] as [string, string]));
  }

  /**
   * While a reconciliation session is active (initializing / waiting_user /
   * resyncing), nodes inside the mounted scope may not yet have mirror rows.
   * Record their browser ids on the active session so finish() can diff and
   * queue them once identities are assigned (R32, doc 22 B.12).
   */
  private async markReconDirtyIfActive(binding: BindingRecord, browserId: string): Promise<boolean> {
    if (
      binding.state !== 'initializing' &&
      binding.state !== 'waiting_user' &&
      binding.state !== 'resyncing'
    ) {
      return false;
    }
    const session = await activeReconSession(this.db, binding.id);
    if (!session) return false;
    const set = new Set(session.dirtyBrowserIds ?? []);
    set.add(browserId);
    session.dirtyBrowserIds = [...set];
    session.updatedAt = Date.now();
    await this.db.reconSessions.put(session);
    return true;
  }

  /**
   * Managed scope check (doc 03): full mode owns the whole profile tree;
   * partial mode owns the mount folder subtree. Walks up via the mirror first
   * and falls back to live browser ancestry so unmapped nodes touched during
   * initial sync / waiting_user are still captured (R32).
   */
  private async isManagedScope(
    binding: BindingRecord,
    browserId: string | null,
    fallbackParentId: string | null = null,
  ): Promise<boolean> {
    if (browserId == null) return false;
    if (binding.mount.mode === 'full') return true;
    const mountId = binding.mount.folderBrowserId;
    if (!mountId) return false;
    let cur: string | null = browserId;
    for (let i = 0; i < 64 && cur != null; i++) {
      if (cur === mountId) return true;
      const row: LocalNodeRecord | undefined = await this.db.localNodes.get([binding.id, cur]);
      if (row) {
        cur = row.parentBrowserId;
        continue;
      }
      const live = await this.adapter.getNode(cur);
      if (live) {
        cur = live.parentId;
        continue;
      }
      if (cur === browserId && fallbackParentId != null) {
        cur = fallbackParentId;
        continue;
      }
      return false;
    }
    return false;
  }

  /** Canonical parent ref for a browser parent (root slot or mapped node). */
  private async canonicalParentRef(binding: BindingRecord, parentBrowserId: string): Promise<ParentRefWire | null> {
    const mount = binding.mount;
    if (mount.mode === 'partial' && parentBrowserId === mount.folderBrowserId) {
      return { type: 'root', key: mount.rootKey };
    }
    if (mount.mode === 'full' && mount.roots) {
      for (const [key, browserId] of Object.entries(mount.roots)) {
        if (browserId === parentBrowserId) return { type: 'root', key };
      }
    }
    if (mount.recoveryFolders) {
      for (const [key, browserId] of Object.entries(mount.recoveryFolders)) {
        if (browserId === parentBrowserId) return { type: 'root', key };
      }
    }
    const parent = await this.db.localNodes.get([binding.id, parentBrowserId]);
    if (parent?.canonicalId) return { type: 'node', id: parent.canonicalId };
    return null;
  }

  /**
   * Does the browser parent live under another active binding's scope?
   * Matches the other binding's mount roots (folderBrowserId / roots) and
   * any node already mapped in that binding's mirrors; returns the target
   * binding plus the canonical parent reference for the transfer request.
   */
  private async crossBindingTarget(
    binding: BindingRecord,
    parentBrowserId: string,
  ): Promise<{ binding: BindingRecord; parentRef: ParentRefWire } | null> {
    const others = await this.db.bindings.where('state').equals('active').toArray();
    for (const other of others) {
      if (other.id === binding.id) continue;
      const mount = other.mount;
      if (mount.mode === 'partial' && parentBrowserId === mount.folderBrowserId) {
        return { binding: other, parentRef: { type: 'root', key: mount.rootKey } };
      }
      if (mount.mode === 'full' && mount.roots) {
        for (const [key, browserId] of Object.entries(mount.roots)) {
          if (browserId === parentBrowserId) return { binding: other, parentRef: { type: 'root', key } };
        }
      }
      const parent = await this.db.localNodes.get([other.id, parentBrowserId]);
      if (parent?.canonicalId) return { binding: other, parentRef: { type: 'node', id: parent.canonicalId } };
    }
    return null;
  }
  /**
   * after_id → before_id translation (doc 05 §12): find the next syncable
   * canonical sibling after the moved node's browser index; null = append.
   */
  private async nextSiblingCanonicalId(
    binding: BindingRecord,
    parentBrowserId: string,
    index: number,
  ): Promise<string | null> {
    const children = await this.adapter.getChildren(parentBrowserId);
    for (const child of children) {
      if (child.index <= index) continue;
      const m = await this.db.localNodes.get([binding.id, child.id]);
      if (m?.canonicalId) return m.canonicalId;
    }
    return null;
  }
}

export type { PendingOpRecord };
