import { useMemo, useState } from 'react';
import { Button, Group, Modal, Select } from '@mantine/core';
import type { Node, ParentRef, RootSlot } from '@pontis/api';
import { listFolders, pathTitles } from '../../features/explorer';
import type { TreeIndex } from '../../features/explorer';

interface MoveNodesModalProps {
  opened: boolean;
  /** Rows being moved. */
  nodes: Node[];
  index: TreeIndex;
  rootSlots: RootSlot[];
  pending?: boolean;
  onClose: () => void;
  onSubmit: (parent: ParentRef, label: string) => void;
}

interface Target {
  parent: ParentRef;
  label: string;
}

/**
 * Pick a folder in this space (or a root slot) as the new parent for the
 * selection. A selected folder — and everything under it — is left out of
 * the list, so a folder can never be moved inside itself.
 */
export default function MoveNodesModal({
  opened,
  nodes,
  index,
  rootSlots,
  pending,
  onClose,
  onSubmit,
}: MoveNodesModalProps) {
  const forbidden = useMemo(() => {
    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of index.childrenOf(id)) collect(child.id);
    };
    for (const node of nodes) if (node.type === 'folder') collect(node.id);
    return ids;
  }, [nodes, index]);

  // The indent this list used to draw said which folder was which; a path says
  // the same thing in one line and stays readable while the list is filtered.
  const targets = useMemo<Target[]>(() => {
    const folders = listFolders(index, forbidden).map(({ node }) => ({
      parent: { type: 'node' as const, id: node.id },
      label: pathTitles(index, node.id).join(' / '),
    }));
    const roots = rootSlots.map((slot) => ({
      parent: { type: 'root' as const, key: slot.key },
      label: `根目录 / ${slot.display_name || '根目录'}`,
    }));
    return [...roots, ...folders];
  }, [index, forbidden, rootSlots]);

  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const chosen = targets.find((t) => targetKey(t) === choiceKey);
  // The modal unmounts its children on close but this component outlives it,
  // so the picked target is cleared by hand.
  const reset = () => setChoiceKey(null);

  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title={`移动 ${nodes.length} 项`}
      size={380}
    >
      <Select
        label="目标文件夹"
        placeholder="选择要移动到哪个文件夹"
        searchable
        value={choiceKey}
        onChange={setChoiceKey}
        data={targets.map((t) => ({ value: targetKey(t), label: t.label }))}
      />

      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={() => { reset(); onClose(); }}>
          取消
        </Button>
        <Button
          disabled={!chosen}
          loading={pending}
          onClick={() => {
            if (!chosen) return;
            onSubmit(chosen.parent, chosen.label);
          }}
        >
          移动到此处
        </Button>
      </Group>
    </Modal>
  );
}

const targetKey = (t: Target) => (t.parent.type === 'root' ? `root:${t.parent.key}` : `node:${t.parent.id}`);
