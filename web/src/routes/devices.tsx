import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Group,
  Menu,
  Modal,
  Skeleton,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconBrandChrome,
  IconBrandEdge,
  IconBrandFirefox,
  IconBrandSafari,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCheck,
  IconDeviceDesktop,
  IconDotsVertical,
  IconPlus,
  IconQrcode,
  IconRefresh,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import type { BindingHealth, DeviceBindingView, DeviceOverview } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import ExtensionInstall from '../components/devices/ExtensionInstall';
import { contentRegion } from '../styles/app-shell.css';
import {
  pagePad,
  mono,
  statusDot,
  statusDotPulsing,
  rowHover,
  detailRow,
} from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import {
  useDeviceOverview,
  useRegisterDevice,
  useRevokeDevice,
  useDeleteDevice,
  usePairingCode,
} from '../hooks/use-devices';
import { formatRelativeTime } from '../lib/format';

// ─── Status presentation ─────────────────────────────────────

interface HealthMeta {
  label: string;
  color: string;
  pulse?: boolean;
  quiet?: boolean;
}

const HEALTH_META: Record<BindingHealth, HealthMeta> = {
  healthy: { label: '已同步', color: tokens.syncHealthy, quiet: true },
  syncing: { label: '同步中', color: tokens.accent, pulse: true },
  warning: { label: '待处理', color: tokens.syncWarning },
  recovery: { label: '需要恢复', color: tokens.syncRecovery },
  offline: { label: '离线', color: tokens.textDisabled },
  suspended: { label: '已暂停', color: tokens.textDisabled },
};

/** A device is only as healthy as its worst binding; normal states stay quiet. */
const SEVERITY: BindingHealth[] = [
  'recovery',
  'warning',
  'offline',
  'suspended',
  'syncing',
  'healthy',
];

function deviceHealth(device: DeviceOverview): BindingHealth | null {
  let worst: BindingHealth | null = null;
  for (const b of device.bindings) {
    if (worst === null || SEVERITY.indexOf(b.health) < SEVERITY.indexOf(worst)) {
      worst = b.health;
    }
  }
  return worst;
}

function StatusCell({ health, revokedAt }: { health: BindingHealth | null; revokedAt?: string | null }) {
  // A revoked device is not "未绑定": it stopped syncing on purpose and is
  // waiting for the owner to delete the record.
  if (revokedAt) {
    return (
      <Group gap={6} wrap="nowrap">
        <span className={statusDot} style={{ backgroundColor: tokens.textDisabled }} />
        <Text fz={13} c="dimmed">已撤销</Text>
      </Group>
    );
  }
  if (!health) {
    return (
      <Group gap={6} wrap="nowrap">
        <span className={statusDot} style={{ backgroundColor: tokens.textDisabled }} />
        <Text fz={13} c="dimmed">未绑定</Text>
      </Group>
    );
  }
  const meta = HEALTH_META[health];
  return (
    <Group gap={6} wrap="nowrap">
      <span
        className={`${statusDot} ${meta.pulse ? statusDotPulsing : ''}`}
        style={{ backgroundColor: meta.color }}
      />
      <Text fz={13} c={meta.quiet ? 'dimmed' : undefined} style={{ color: meta.quiet ? undefined : meta.color }}>
        {meta.label}
      </Text>
    </Group>
  );
}

// ─── Device identity presentation ────────────────────────────

const BROWSER_ICON: Record<string, typeof IconDeviceDesktop> = {
  chrome: IconBrandChrome,
  edge: IconBrandEdge,
  firefox: IconBrandFirefox,
  safari: IconBrandSafari,
};

const PLATFORM_LABEL: Record<string, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
};

const MODE_LABEL: Record<string, string> = {
  full: '整体同步',
  partial: '部分同步',
};

function DeviceName({ device }: { device: DeviceOverview }) {
  const BrowserIcon = BROWSER_ICON[device.browser] ?? IconDeviceDesktop;
  const platform = PLATFORM_LABEL[device.platform] ?? device.platform;
  return (
    <Group gap={8} wrap="nowrap">
      <BrowserIcon size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <Text fz={13} fw={500} truncate="end">{device.name}</Text>
        <Text fz={12} c="dimmed">{platform || '未知平台'}</Text>
      </div>
    </Group>
  );
}

// ─── Page ─────────────────────────────────────────────────────

export default function DevicesPage() {
  const { data, isLoading, isError, error, refetch } = useDeviceOverview();
  const register = useRegisterDevice();
  const revoke = useRevokeDevice();
  const delDevice = useDeleteDevice();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  /** Which device a confirmation is about, and which of the two steps it is. */
  const [confirm, setConfirm] = useState<{ device: DeviceOverview; action: 'revoke' | 'delete' } | null>(null);

  const devices = data?.devices ?? [];

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (!confirm) return;
    const { device, action } = confirm;
    const mutation = action === 'revoke' ? revoke : delDevice;
    mutation.mutate(device.id, {
      onSuccess: () => {
        notifications.show({
          message:
            action === 'revoke'
              ? `已撤销「${device.name}」，该设备不再同步；确认后可以删除它的记录`
              : `已删除「${device.name}」的记录`,
          color: 'coolGray',
        });
        setConfirm(null);
      },
      onError: (e) =>
        notifications.show({
          message: e instanceof Error ? e.message : action === 'revoke' ? '撤销失败' : '删除失败',
          color: 'errorRed',
        }),
    });
  };

  return (
    <>
      <Header breadcrumb="设备" primaryAction={{ label: '添加设备', icon: <IconPlus size={14} stroke={1.5} />, onClick: () => setAddOpen(true) }} />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group justify="space-between" mb="sm">
          <Text fz={13} c="dimmed">
            设备是浏览器 Profile 中的一次扩展安装。每个设备可以绑定一个或多个同步空间。
          </Text>
          <Button
            size="compact-sm"
            variant="subtle"
            leftSection={<IconQrcode size={14} stroke={1.5} />}
            onClick={() => setPairOpen(true)}
          >
            生成配对码
          </Button>
        </Group>

        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={44} />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <EmptyDevices onAdd={() => setAddOpen(true)} />
        ) : (
          <Table
            verticalSpacing={9}
            horizontalSpacing={12}
            withRowBorders={false}
            styles={{
              table: { tableLayout: 'fixed' },
              th: { fontSize: 12, fontWeight: 500, color: tokens.textSecondary },
              td: { fontSize: 13 },
            }}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={44} />
                <Table.Th>设备</Table.Th>
                <Table.Th w={110}>模式</Table.Th>
                <Table.Th>绑定空间</Table.Th>
                <Table.Th w={130}>状态</Table.Th>
                <Table.Th w={120}>最后活动</Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  expanded={expanded.has(device.id)}
                  onToggle={() => toggleExpand(device.id)}
                  onRevoke={() => setConfirm({ device, action: 'revoke' })}
                  onDelete={() => setConfirm({ device, action: 'delete' })}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}

        {/* Install surface stays on this page for both states: an account with
            no devices yet is the one that needs the package, and a list full of
            devices is where you go when adding one. */}
        <div style={{ marginTop: 28 }}>
          <ExtensionInstall />
        </div>
      </div>

      <PairingCodeModal
        opened={pairOpen}
        onClose={() => setPairOpen(false)}
      />
      <AddDeviceModal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        registering={register.isPending}
        onRegister={(name) =>
          new Promise((resolve, reject) =>
            register.mutate(
              { name, client_type: 'extension' },
              { onSuccess: resolve, onError: (e) => reject(e instanceof Error ? e : new Error('注册失败')) },
            ),
          )
        }
      />

      <Modal
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm
            ? confirm.action === 'revoke'
              ? `撤销「${confirm.device.name}」？`
              : `删除「${confirm.device.name}」的记录？`
            : ''
        }
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          {confirm?.action === 'revoke'
            ? `${confirm.device.name} 现在同步 ${confirm.device.bindings.length} 个空间，撤销后这些空间立即停止同步；其它设备不受影响。设备上的本地书签不会被删除，但它要重新注册才能再拿回同步权限。撤销后这条设备记录会留在列表里，等你确认再删。`
            : `${confirm?.device.name} 已经撤销。删除记录后它不再出现在列表里；服务器上的空间与书签不受影响。这一步没有回退，历史记录仍会保留在日志里。`}
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setConfirm(null)}>
            取消
          </Button>
          <Button
            color="errorRed"
            loading={(confirm?.action === 'revoke' ? revoke : delDevice).isPending}
            onClick={handleConfirm}
          >
            {confirm?.action === 'revoke' ? '撤销设备' : '删除记录'}
          </Button>
        </Group>
      </Modal>
    </>
  );
}

// ─── Table row ────────────────────────────────────────────────

function DeviceRow({
  device,
  expanded,
  onToggle,
  onRevoke,
  onDelete,
}: {
  device: DeviceOverview;
  expanded: boolean;
  onToggle: () => void;
  onRevoke: () => void;
  onDelete: () => void;
}) {
  const hasBindings = device.bindings.length > 0;
  const revoked = !!device.revoked_at;
  return (
    <>
      <Table.Tr className={rowHover}>
        <Table.Td>
          {hasBindings && (
            <UnstyledButton
              onClick={onToggle}
              aria-label={expanded ? '收起绑定详情' : '展开绑定详情'}
              aria-expanded={expanded}
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 2 }}
            >
              {expanded ? (
                <IconChevronDown size={14} stroke={1.7} />
              ) : (
                <IconChevronRight size={14} stroke={1.7} />
              )}
            </UnstyledButton>
          )}
        </Table.Td>
        <Table.Td><DeviceName device={device} /></Table.Td>
        <Table.Td>
          <Text fz={13} c={device.sync_mode ? undefined : 'dimmed'}>
            {MODE_LABEL[device.sync_mode] ?? '—'}
          </Text>
        </Table.Td>
        <Table.Td>
          {hasBindings ? (
            <Group gap={4}>
              {device.bindings.map((b) => (
                <Badge
                  key={b.id}
                  variant="light"
                  color="coolGray"
                  styles={{ root: { fontWeight: 400 } }}
                >
                  {b.space_name}
                </Badge>
              ))}
            </Group>
          ) : (
            <Text fz={13} c="dimmed">—</Text>
          )}
        </Table.Td>
        <Table.Td><StatusCell health={deviceHealth(device)} revokedAt={device.revoked_at} /></Table.Td>
        <Table.Td c="dimmed" fz={12}>
          {device.last_seen_at ? formatRelativeTime(device.last_seen_at) : '从未连接'}
        </Table.Td>
        <Table.Td>
          <Menu shadow="md" width={160} position="bottom-end">
            <Menu.Target>
              <UnstyledButton
                aria-label="设备操作"
                style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4, borderRadius: 4 }}
              >
                <IconDotsVertical size={16} stroke={1.5} />
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {!revoked && (
                <Menu.Item
                  leftSection={<IconShieldOff size={14} stroke={1.5} />}
                  disabled={!hasBindings}
                >
                  暂停同步
                </Menu.Item>
              )}
              {revoked ? (
                <Menu.Item
                  color="errorRed"
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  onClick={onDelete}
                >
                  删除设备记录
                </Menu.Item>
              ) : (
                <Menu.Item
                  color="errorRed"
                  leftSection={<IconShieldOff size={14} stroke={1.5} />}
                  onClick={onRevoke}
                >
                  撤销此设备
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Table.Td>
      </Table.Tr>
      {expanded &&
        device.bindings.map((binding) => (
          <BindingDetailRow key={binding.id} binding={binding} />
        ))}
    </>
  );
}

function BindingDetailRow({ binding }: { binding: DeviceBindingView }) {
  const meta = HEALTH_META[binding.health];
  return (
    <Table.Tr className={detailRow}>
      <Table.Td />
      <Table.Td colSpan={3} py={7}>
        <Group gap={10} wrap="nowrap">
          <span
            className={`${statusDot} ${meta.pulse ? statusDotPulsing : ''}`}
            style={{ backgroundColor: meta.color, width: 6, height: 6 }}
          />
          <Text fz={13}>{binding.space_name}</Text>
          <Text fz={12} c="dimmed">
            {binding.sync_mode === 'full' ? '整体' : '部分'} · {binding.state === 'active' ? '活跃' : binding.state === 'suspended' ? '已暂停' : '等待初始同步'}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td py={7}>
        <Tooltip
          label={`Epoch ${binding.epoch}`}
          withArrow
          position="top"
        >
          <span className={mono} style={{ color: tokens.textSecondary }}>
            {binding.applied_revision} → {binding.server_revision}
          </span>
        </Tooltip>
      </Table.Td>
      <Table.Td py={7} fz={12} c="dimmed">
        {binding.last_sync_at ? formatRelativeTime(binding.last_sync_at) : '—'}
      </Table.Td>
      <Table.Td />
    </Table.Tr>
  );
}

// ─── Add device flow ──────────────────────────────────────────

interface RegisterResult {
  device: { id: string; name: string };
  token: string;
}

function AddDeviceModal({
  opened,
  onClose,
  registering,
  onRegister,
}: {
  opened: boolean;
  onClose: () => void;
  registering: boolean;
  onRegister: (name: string) => Promise<RegisterResult>;
}) {
  const [step, setStep] = useState<'form' | 'secret'>('form');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);

  const reset = () => {
    setStep('form');
    setName('');
    setNameError(null);
    setResult(null);
  };

  const close = () => {
    onClose();
    // Keep the modal contents until the fade-out finishes.
    window.setTimeout(reset, 200);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1) {
      setNameError('设备名称不能为空');
      return;
    }
    try {
      const res = await onRegister(trimmed);
      setResult(res);
      setStep('secret');
    } catch (e) {
      setNameError(e instanceof Error ? e.message : '注册失败');
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={step === 'form' ? '添加设备' : '设备密钥'}
      size={440}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      {step === 'form' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextInput
            label="设备名称"
            description="建议使用「浏览器 + 平台」格式,例如 Edge on MacBook"
            placeholder="Edge on MacBook"
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setNameError(null);
            }}
            error={nameError ?? undefined}
            data-autofocus
          />
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={close}>
              取消
            </Button>
            <Button type="submit" loading={registering}>
              注册
            </Button>
          </Group>
        </form>
      ) : (
        <div>
          <Text fz={13}>
            在「{result?.device.name}」上的 Pontis 扩展中输入此密钥完成绑定。
            <strong style={{ fontWeight: 600 }}>此密钥只显示一次</strong>,关闭后将无法再次查看。
          </Text>
          <div
            className={mono}
            style={{
              marginTop: 12,
              padding: '10px 12px',
              backgroundColor: tokens.raisedBg,
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 6,
              wordBreak: 'break-all',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <span style={{ flex: 1 }}>{result?.token}</span>
            <CopyButton value={result?.token ?? ''}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? '已复制' : '复制'} withArrow>
                  <UnstyledButton
                    onClick={copy}
                    aria-label="复制密钥"
                    style={{ color: copied ? tokens.syncHealthy : tokens.textSecondary, display: 'inline-flex' }}
                  >
                    {copied ? <IconCheck size={15} stroke={1.7} /> : <IconCopy size={15} stroke={1.5} />}
                  </UnstyledButton>
                </Tooltip>
              )}
            </CopyButton>
          </div>
          <Group justify="flex-end" mt="lg">
            <Button onClick={close}>我已保存密钥</Button>
          </Group>
        </div>
      )}
    </Modal>
  );
}

function EmptyDevices({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 260,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconDeviceDesktop size={32} stroke={1.2} />
      <Text fz="sm">还没有注册任何设备</Text>
      <Text fz="xs" c="dimmed">
        在浏览器中安装 Pontis 扩展并注册后,即可开始同步书签。
      </Text>
      <Button size="compact-sm" variant="subtle" onClick={onAdd} mt={4} leftSection={<IconPlus size={14} stroke={1.5} />}>
        添加设备
      </Button>
    </div>
  );
}

// ─── Pairing code ────────────────────────────────────────────

/** Seconds a freshly minted pairing code stays redeemable (mirrors the server). */
const PAIRING_CODE_TTL_SECONDS = 600;

/**
 * Shows a one-time code the extension can redeem for a device credential —
 * for an SSO account that has no password to type, and for anyone who would
 * rather not paste one into a form. A fresh code is minted on every open;
 * the countdown says how long the screen still means anything.
 */
function PairingCodeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const pairing = usePairingCode();
  const [remaining, setRemaining] = useState<number>(0);

  const mint = () => {
    pairing.mutate(undefined, {
      onSuccess: (res) => {
        const expiresAt = new Date(res.expires_at).getTime();
        const tick = () => setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
        tick();
        const timer = window.setInterval(() => {
          tick();
          // Stop counting a code that is already spent or expired.
          if (Date.now() >= expiresAt) window.clearInterval(timer);
        }, 1000);
        window.setTimeout(() => window.clearInterval(timer), (PAIRING_CODE_TTL_SECONDS + 2) * 1000);
      },
    });
  };

  // Every open mints a new code: an old one on screen may already be spent,
  // and the dialog must never show a code it cannot vouch for.
  useEffect(() => {
    if (opened) mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const code = pairing.data?.code ?? '';
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="扩展配对码"
      size={440}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Text fz={13}>
        在扩展登录界面选择「配对码登录」,输入下面的码即可完成配对,无需输入账号密码。
        <strong style={{ fontWeight: 600 }}>配对码 10 分钟内有效,且只能使用一次</strong>。
      </Text>
      {pairing.isPending ? (
        <Skeleton height={52} mt={12} radius={6} />
      ) : pairing.isError ? (
        <>
          <Alert color="errorRed" variant="light" mt={12} icon={<IconAlertCircle size={16} />}>
            {pairing.error instanceof Error ? pairing.error.message : '生成配对码失败'}
          </Alert>
          <Group justify="flex-end" mt="lg">
            <Button onClick={mint} leftSection={<IconRefresh size={14} stroke={1.5} />}>
              重试
            </Button>
          </Group>
        </>
      ) : (
        <>
          <div
            className={mono}
            style={{
              marginTop: 12,
              padding: '10px 12px',
              backgroundColor: tokens.raisedBg,
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ flex: 1, fontSize: 20, letterSpacing: 2 }}>{code}</span>
            <CopyButton value={code}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? '已复制' : '复制'} withArrow>
                  <UnstyledButton
                    onClick={copy}
                    aria-label="复制配对码"
                    style={{ color: copied ? tokens.syncHealthy : tokens.textSecondary, display: 'inline-flex' }}
                  >
                    {copied ? <IconCheck size={15} stroke={1.7} /> : <IconCopy size={15} stroke={1.5} />}
                  </UnstyledButton>
                </Tooltip>
              )}
            </CopyButton>
          </div>
          <Group justify="space-between" mt="sm">
            <Text fz="xs" c={remaining > 0 ? 'dimmed' : 'errorRed'}>
              {remaining > 0 ? `有效期剩余 ${minutes}:${seconds}` : '已过期,请重新生成'}
            </Text>
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRefresh size={14} stroke={1.5} />}
              onClick={mint}
            >
              重新生成
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
