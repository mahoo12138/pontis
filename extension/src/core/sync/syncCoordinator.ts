// Sync Coordinator (doc 05 §6/§15): one /sync round per binding —
//   drain inbox → push QUEUED ops + pull changes → persist response +
//   inbox atomically, advance received_revision → apply inbox serially
//   → settle pending ops. Loops while has_more. Never trusts HTTP success
//   alone; pending cleanup follows settle_after_revision (doc 04 §7).

import { ApiError, type SyncTransport, type TransferTransport } from '../transport/client';
import {
  acquireRunLock,
  activeReconSession,
  collectSubtree,
  logDiagnostic,
  releaseRunLock,
  renewRunLock,
  isSyncEnabled,
  type BindingRecord,
  type LocalNodeRecord,
  type PontisDB,
  type PendingOpRecord,
  type SyncNotice,
} from '../store/db';
import { uuidv7 } from '../util/ids';
import {
  MAX_CHANGES_PER_ROUND,
  SYNC_PROTOCOL_VERSION,
  type OpType,
  type OperationResultWire,
  type OperationWire,
  type SyncRequestWire,
  type SyncResponseWire,
  type TransferResponseWire,
} from '../protocol/types';
import { UnmappedProjectionError, type RemoteChangeApplier } from './remoteChangeApplier';

export type SyncOutcome = 'synced' | 'needs-recovery' | 'inactive' | 'busy' | 'error';

/** Safety valve so a stuck has_more loop can't spin forever. */
const MAX_ROUNDS_PER_SYNC = 20;
/** Cap operations per /sync batch to stay well under server batch limits (R21). */
const MAX_OPS_PER_ROUND = 200;

export class SyncCoordinator {
  constructor(
    private db: PontisDB,
    private applier: RemoteChangeApplier,
    private transport: SyncTransport,
    private transfers?: TransferTransport,
  ) {}

  async syncBinding(bindingId: string): Promise<SyncOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || !(await this.canRun(binding))) return 'inactive';
    // One holder per binding. An alarm, a manual click, a worker wake and a
    // recovery attempt otherwise interleave on the same inbox and the same
    // watermarks, and the replica ends up reporting a tree it never applied.
    const lockToken = uuidv7();
    if (!(await acquireRunLock(this.db, bindingId, lockToken))) {
      // Distinct from 'inactive': the binding does want a round, and something
      // else is inside it. A caller that treats the two the same way drops the
      // work until the next alarm, which is minutes away.
      await logDiagnostic(this.db, 'info', 'coordinator', '另一轮正在处理该绑定，本轮跳过', {
        bindingId,
      });
      return 'busy';
    }
    try {
      return await this.rounds(bindingId, lockToken);
    } finally {
      await releaseRunLock(this.db, bindingId, lockToken);
    }
  }

  private async rounds(bindingId: string, lockToken: string): Promise<SyncOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || !(await this.canRun(binding))) return 'inactive';

    // Finish apply work interrupted by a previous crash (doc 05 §10).
    await this.applier.recover(bindingId);

    for (let round = 0; round < MAX_ROUNDS_PER_SYNC; round++) {
      // Renew the lease before each round so large catch-up syncs never get
      // their run lock stolen mid-flight (R24).
      await renewRunLock(this.db, bindingId, lockToken);
      const b = await this.db.bindings.get(bindingId);
      if (!b || !(await this.canRun(b))) return 'inactive';

      const { request: req, hasMoreOps } = await this.buildRequest(b.id);
      let resp: SyncResponseWire;
      try {
        resp = await this.transport.sync(b.id, req);
      } catch (err) {
        // Binding continuity broken (doc 04 §12/§14): pause and surface.
        // NOT_BINDING_OWNER is terminal rather than a sync-protocol break: a
        // replica copied into another profile can never own the binding, so
        // retrying it every round would only bury the real error.
        const terminal = err instanceof ApiError && (err.isProtocolError || err.code === 'NOT_BINDING_OWNER');
        if (terminal) {
          await this.db.bindings.update(b.id, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', '该副本无法同步此绑定，需要恢复', {
            bindingId: b.id,
            code: err.code,
          });
          return 'needs-recovery';
        }
        await logDiagnostic(this.db, 'warn', 'coordinator', '本轮同步失败，稍后重试', {
          bindingId: b.id,
          error: String(err),
        });
        return 'error';
      }

      // Rule 3 (doc 05 §16): persist results + inbox, THEN advance
      // received_revision — all in one transaction.
      const notableResults: Array<{ op: PendingOpRecord; result: OperationResultWire }> = [];
      await this.db.transaction(
        'rw',
        [this.db.bindings, this.db.pendingOps, this.db.remoteChanges, this.db.localNodes],
        async () => {
          const current = await this.db.bindings.get(b.id);
          if (!current) return;
          if (current.epoch !== resp.epoch) {
            // Epoch changed behind our back: needs recovery, not replay.
            current.state = 'needs_recovery';
            current.recovery = { code: 'EPOCH_MISMATCH', message: 'epoch changed mid-sync' };
            await this.db.bindings.put(current);
            return;
          }
          let latestNotice: SyncNotice | null = null;
          for (const r of resp.operation_results) {
            const recorded = await this.recordResult(b.id, r);
            if (recorded && (r.status === 'REJECTED' || r.status === 'CONFLICT' || r.status === 'RECOVERED')) {
              notableResults.push({ op: recorded, result: r });
              latestNotice = noticeForResult(r);
            }
          }
          for (const c of resp.changes) {
            await this.db.remoteChanges.put({
              id: `${b.id}:${c.revision}`,
              bindingId: b.id,
              revision: c.revision,
              type: c.type,
              nodeId: c.node_id,
              payload: c.payload,
            });
          }
          current.receivedRevision = Math.max(current.receivedRevision, resp.through_revision);
          if (latestNotice) {
            current.lastNotice = latestNotice;
          }
          await this.db.bindings.put(current);
        },
      );

      // R16: Log non-APPLIED operation outcomes (CONFLICT / RECOVERED / REJECTED)
      // outside the IDB transaction so users and diagnostics have full visibility.
      for (const { op, result } of notableResults) {
        const level = result.status === 'REJECTED' ? 'error' : 'warn';
        await logDiagnostic(this.db, level, 'coordinator', diagnosticLabelForResult(result), {
          bindingId: b.id,
          opId: result.op_id,
          opType: op.type,
          nodeId: op.nodeId,
          status: result.status,
          reason: result.reason,
        });
      }

      const afterPersist = await this.db.bindings.get(b.id);
      if (afterPersist && afterPersist.state === 'needs_recovery') return 'needs-recovery';

      // Apply the inbox strictly serially (doc 05 §7). A change that targets
      // a lost mapping stops the run here: applied_revision keeps its last
      // genuinely reached value and the binding asks for repair.
      const inbox = await this.db.remoteChanges
        .where('[bindingId+revision]')
        .between([b.id, b.appliedRevision + 1], [b.id, Number.MAX_SAFE_INTEGER], true, true)
        .sortBy('revision');
      for (const rec of inbox) {
        try {
          await this.applier.applyChange(b.id, {
            revision: rec.revision,
            type: rec.type,
            node_id: rec.nodeId,
            payload: rec.payload as SyncResponseWire['changes'][number]['payload'],
          });
        } catch (err) {
          if (!(err instanceof UnmappedProjectionError)) throw err;
          await this.db.bindings.update(b.id, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', '远端改动指向已丢失的映射', {
            bindingId: b.id,
            revision: rec.revision,
            kind: err.kind,
            target: err.target,
          });
          return 'needs-recovery';
        }
      }

      // HTTP success ≠ pending deletable: settle only what the server
      // says is safe (doc 04 §7, doc 22 B.7).
      await this.settlePending(b.id);

      if (!resp.has_more && !hasMoreOps) break;
    }

    // Cross-space transfers (doc 03 §7) ride their own endpoint; they are
    // not /sync operations. Upload any QUEUED ones after the rounds.
    await this.processTransfers(bindingId);

    await this.db.bindings.update(bindingId, { lastSyncAt: Date.now() });
    return 'synced';
  }

  /** True when at least one binding wanted a round and lost the lock. */
  async syncAll(): Promise<boolean> {
    let busy = false;
    const bindings = await this.db.bindings.where('state').equals('active').toArray();
    for (const b of bindings) {
      // A switched-off binding keeps capturing local edits — the journal still
      // describes the browser — it just spends no round on the network. This
      // is the same shape as an offline device reconnecting, which the server
      // already has to survive.
      if (!isSyncEnabled(b)) continue;
      try {
        if ((await this.syncBinding(b.id)) === 'busy') busy = true;
      } catch (err) {
        await logDiagnostic(this.db, 'error', 'coordinator', '未预期的同步失败', {
          bindingId: b.id,
          error: String(err),
        });
      }
    }
    return busy;
  }

  /**
   * Incremental rounds run when the binding is active, or when an active
   * reconciliation session is in its apply/verify phases (the engine
   * drives the loop then; WAITING_USER and other phases pause us).
   */
  private async canRun(binding: BindingRecord): Promise<boolean> {
    if (binding.state === 'active') return true;
    if (binding.state !== 'initializing' && binding.state !== 'resyncing') return false;
    const session = await activeReconSession(this.db, binding.id);
    return session != null && (session.phase === 'apply' || session.phase === 'verify');
  }

  private async buildRequest(bindingId: string): Promise<{ request: SyncRequestWire; hasMoreOps: boolean }> {
    const b = (await this.db.bindings.get(bindingId))!;
    // An operation that has already been sent keeps its payload forever: the
    // server replays its receipt for the same body and refuses a different one
    // as OP_ID_REUSED (doc 04). So the round takes the outstanding ops — queued
    // ones and any an earlier round never got an answer for — and marks them
    // in flight before the request leaves.
    const outstanding = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .toArray();
    const inFlight = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'IN_FLIGHT'])
      .toArray();
    const all = [...outstanding, ...inFlight].sort((x, y) => x.clientSeq - y.clientSeq);
    // Transfer intents never appear as /sync operations.
    const syncOps = all.filter((o): o is PendingOpRecord & { type: OpType } => o.type !== 'transfer');
    const batch = syncOps.slice(0, MAX_OPS_PER_ROUND);
    await this.markInFlight(batch.map((o) => o.opId));
    return {
      request: {
        protocol_version: SYNC_PROTOCOL_VERSION,
        epoch: b.epoch,
        applied_revision: b.appliedRevision,
        received_revision: b.receivedRevision,
        operations: batch.map(toWire),
        max_changes: MAX_CHANGES_PER_ROUND,
      },
      hasMoreOps: syncOps.length > batch.length,
    };
  }

  /**
   * Freeze the ops this round is carrying. They stay in flight until the
   * server answers for them by name, which is also what makes a retry after a
   * lost response send exactly what the first attempt sent.
   */
  private async markInFlight(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return;
    await this.db.transaction('rw', [this.db.pendingOps], async () => {
      for (const opId of opIds) await this.db.pendingOps.update(opId, { status: 'IN_FLIGHT' });
    });
  }

  /**
   * Upload QUEUED transfer intents to /sync/transfers (doc 08 §15).
   * On ack, the source binding's subtree mirrors are dropped and the
   * target binding's mirrors rebuilt from the response mapping (browser
   * ids are reused); the pending op is deleted. The subsequent回流
   * converges naturally: source delete → NOOP advance, target create →
   * ensure-state advance (mirrors already satisfy the changes).
   */
  private async processTransfers(bindingId: string): Promise<void> {
    if (!this.transfers) return;
    const ops = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .filter((o) => o.type === 'transfer')
      .toArray();
    for (const op of ops) {
      if (op.type !== 'transfer' || !op.targetSpaceId || !op.targetParent) continue;
      const source = await this.db.bindings.get(op.bindingId);
      if (!source) continue;
      let resp: TransferResponseWire;
      try {
        resp = await this.transfers.createTransfer({
          transfer_id: op.opId,
          source_space_id: source.spaceId,
          target_space_id: op.targetSpaceId,
          node_id: op.nodeId,
          target_parent: op.targetParent,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          // Permanent rejection (e.g. TRANSFER_ID_REUSED): surface it, do
          // not retry forever.
          await this.db.pendingOps.update(op.opId, {
            status: 'RESOLVED',
            keepResolved: true,
            result: {
              status: 'CONFLICT',
              reason: err.code,
              resultRevision: 0,
              settleAfterRevision: Number.MAX_SAFE_INTEGER,
            },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', '跨空间搬运被服务端拒绝', {
            bindingId: op.bindingId,
            opId: op.opId,
            code: err.code,
          });
          continue;
        }
        await logDiagnostic(this.db, 'warn', 'coordinator', '跨空间搬运上传失败，稍后重试', {
          bindingId: op.bindingId,
          opId: op.opId,
          error: String(err),
        });
        continue;
      }
      await this.commitTransferAck(op, resp);
    }
  }

  /** Ack bookkeeping: rebuild mirrors on both sides in one transaction. */
  private async commitTransferAck(op: PendingOpRecord, resp: TransferResponseWire): Promise<void> {
    const sourceBinding = await this.db.bindings.get(op.bindingId);
    if (!sourceBinding || !op.browserId) return;
    const mapping = new Map(resp.mapping.map((m) => [m.source_node_id, m.target_node_id]));
    const targetBinding = await this.db.bindings.where('spaceId').equals(op.targetSpaceId ?? '').first();

    // The browser tree already holds the subtree at its new location, so
    // the old source mirrors carry the browser ids to re-map.
    const subtree = await collectSubtree(this.db, op.bindingId, op.browserId);
    const targetMirrors: LocalNodeRecord[] = [];
    for (const m of subtree) {
      const canonical = m.canonicalId == null ? null : (mapping.get(m.canonicalId) ?? null);
      if (canonical == null) continue;
      targetMirrors.push({
        ...m,
        bindingId: targetBinding?.id ?? m.bindingId,
        canonicalId: canonical,
        // Only the moved root changes parents; children keep theirs.
        parentBrowserId: m.browserId === op.browserId ? (op.browserParentId ?? m.parentBrowserId) : m.parentBrowserId,
        position: null,
      });
    }

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      await this.db.localNodes.bulkDelete(subtree.map((r) => [op.bindingId, r.browserId] as [string, string]));
      if (targetBinding) {
        await this.db.localNodes.bulkPut(targetMirrors);
      }
      await this.db.pendingOps.delete(op.opId);
    });
    await logDiagnostic(this.db, 'info', 'coordinator', '跨空间搬运已确认，映射已重建', {
      bindingId: op.bindingId,
      opId: op.opId,
      nodes: resp.mapping.length,
    });
  }

  private async recordResult(bindingId: string, r: OperationResultWire): Promise<PendingOpRecord | undefined> {
    const pending: PendingOpRecord | undefined = await this.db.pendingOps.get(r.op_id);
    if (!pending) return undefined;
    pending.status = 'RESOLVED';
    pending.result = {
      status: r.status,
      reason: r.reason,
      resultRevision: r.result_revision,
      settleAfterRevision: r.settle_after_revision,
    };
    await this.db.pendingOps.put(pending);

    // R16: When a local CREATE is permanently REJECTED, drop its provisional
    // canonicalId=null mirror row so the browser bookmark is not stranded as an
    // unmapped orphan whose future edits are silently dropped.
    if (pending.type === 'create' && r.status === 'REJECTED' && pending.browserId) {
      const mirror = await this.db.localNodes.get([bindingId, pending.browserId]);
      if (mirror && mirror.canonicalId == null) {
        await this.db.localNodes.delete([bindingId, pending.browserId]);
      }
    }
    return pending;
  }

  private async settlePending(bindingId: string): Promise<void> {
    const b = await this.db.bindings.get(bindingId);
    if (!b) return;
    const resolved = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'RESOLVED'])
      .toArray();
    for (const p of resolved) {
      const settle = p.result?.settleAfterRevision ?? 0;
      if (settle <= b.appliedRevision && !p.keepResolved) {
        await this.db.pendingOps.delete(p.opId);
      }
    }
  }
}

function noticeForResult(r: OperationResultWire): SyncNotice {
  const now = Date.now();
  if (r.status === 'CONFLICT') {
    return { level: 'warn', code: r.reason || 'CONFLICT', message: '检测到并发冲突，已以服务端最新状态为准', at: now };
  }
  if (r.status === 'RECOVERED') {
    return { level: 'warn', code: r.reason || 'RECOVERED', message: '部分并发新建已自动保护到 Recovered 目录', at: now };
  }
  return {
    level: 'error',
    code: r.reason || 'REJECTED',
    message: r.reason ? `部分本地变更被服务端拒绝（${r.reason}）` : '部分本地变更被服务端拒绝',
    at: now,
  };
}

function diagnosticLabelForResult(r: OperationResultWire): string {
  if (r.status === 'CONFLICT') return '同步操作发生并发冲突，已保留服务端状态';
  if (r.status === 'RECOVERED') return '同步操作触发并发数据保护（Recovered）';
  return '同步操作被服务端拒绝';
}

function toWire(p: PendingOpRecord & { type: OpType }): OperationWire {
  return {
    op_id: p.opId,
    client_seq: p.clientSeq,
    base_revision: p.baseRevision,
    type: p.type,
    node_id: p.nodeId,
    node_type: p.nodeType,
    title: p.title,
    url: p.url,
    parent: p.parent,
    before_id: p.beforeId ?? null,
  };
}
