import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, TagsInput, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PublicationDetail } from '@pontis/api';
import { useUpdatePublication } from '../../hooks/use-plaza';

/**
 * Publisher-side metadata edit. It changes how a publication is listed and
 * described; the snapshot itself only moves through "update from space".
 */
export default function EditMetaModal({
  publication,
  opened,
  onClose,
}: {
  publication: PublicationDetail | null;
  opened: boolean;
  onClose: () => void;
}) {
  const update = useUpdatePublication();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened && publication) {
      setTitle(publication.title);
      setDescription(publication.description);
      setTags(publication.tags);
      setError(null);
    }
  }, [opened, publication]);

  if (!publication) return null;

  const handleSave = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('标题不能为空');
      return;
    }
    setError(null);
    update.mutate(
      {
        id: publication.id,
        params: {
          title: trimmed,
          description: description.trim(),
          tags,
        },
      },
      {
        onSuccess: () => {
          notifications.show({ message: '已更新发布信息', color: 'coolGray' });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`编辑「${publication.title}」`}
      size={480}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Stack gap="sm">
        <TextInput
          label="标题"
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setError(null);
          }}
          error={error ?? undefined}
          data-autofocus
        />
        <TextInput
          label="描述"
          placeholder="一句话介绍这个合集"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        {/* Mantine splits on the half-width comma only; the full-width one is what
            a Chinese input method actually produces, and both were accepted while
            this was a plain text field. */}
        <TagsInput
          label="标签"
          placeholder="输入后按逗号或回车"
          value={tags}
          onChange={setTags}
          splitChars={[',', '，']}
        />
        <Text fz={12} c="dimmed">
          修改只影响列表里的展示,不会改动已经发布的快照内容。
        </Text>
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="coolGray" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave} loading={update.isPending}>
            保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
