import type { ReactNode } from 'react';
import { Button, Group, SegmentedControl } from '@mantine/core';
import {
  IconArrowsSort,
  IconLink,
  IconFileImport,
  IconFileExport,
  IconArchive,
  IconChartDots,
} from '@tabler/icons-react';
import { toolbarRegion } from '../../styles/app-shell.css';
import { tokens } from '../../styles/semantic-tokens.css';

interface ToolbarProps {
  filter: 'all' | 'folders' | 'bookmarks';
  onFilterChange: (filter: 'all' | 'folders' | 'bookmarks') => void;
  onImport?: () => void;
  onExport?: () => void;
  onCheckLinks?: () => void;
  onBackups?: () => void;
  onAnalytics?: () => void;
}

/**
 * A quiet text action in the toolbar's right cluster.
 *
 * Extracted because 导入 and 导出 were the same twenty lines written twice, and
 * a third action would have made that a pattern rather than a slip. It is a
 * `Button` now rather than a styled `<button>`: hover, the focus ring and the
 * press came with the component, and hand-writing them back is how they go
 * missing one action at a time.
 */
function TextButton({
  onClick,
  ariaLabel,
  icon,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Button
      variant="subtle"
      color="coolGray"
      size="compact-sm"
      onClick={onClick}
      aria-label={ariaLabel}
      leftSection={icon}
    >
      {children}
    </Button>
  );
}

export default function Toolbar({
  filter,
  onFilterChange,
  onImport,
  onExport,
  onCheckLinks,
  onBackups,
  onAnalytics,
}: ToolbarProps) {
  return (
    <div className={toolbarRegion}>
      <SegmentedControl
        size="xs"
        value={filter}
        onChange={(v) => onFilterChange(v as ToolbarProps['filter'])}
        data={[
          { label: '全部', value: 'all' },
          { label: '文件夹', value: 'folders' },
          { label: '书签', value: 'bookmarks' },
        ]}
        styles={{
          root: { backgroundColor: tokens.hoverBg },
        }}
      />

      <Group gap="xs" style={{ marginLeft: 'auto' }}>
        {onImport && (
          <TextButton onClick={onImport} ariaLabel="导入书签" icon={<IconFileImport size={14} stroke={1.5} />}>
            导入
          </TextButton>
        )}
        {onExport && (
          <TextButton onClick={onExport} ariaLabel="导出书签" icon={<IconFileExport size={14} stroke={1.5} />}>
            导出
          </TextButton>
        )}
        <Group gap={4} style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}>
          <IconArrowsSort size={14} stroke={1.5} />
          排序
        </Group>
        {onBackups && (
          <Group
            gap={4}
            onClick={onBackups}
            style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}
          >
            <IconArchive size={14} stroke={1.5} />
            备份
          </Group>
        )}
        <Group
          gap={4}
          onClick={onCheckLinks}
          style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}
        >
          <IconLink size={14} stroke={1.5} />
          检查失效链接
        </Group>
        {onAnalytics && (
          <TextButton onClick={onAnalytics} ariaLabel="查看空间分析" icon={<IconChartDots size={14} stroke={1.5} />}>
            分析
          </TextButton>
        )}
      </Group>
    </div>
  );
}
