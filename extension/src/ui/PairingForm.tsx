// Server pairing: the one step that needs a real user gesture.
//
// `chrome.permissions.request` only grants inside a click, and the server sends
// no CORS headers on purpose — so the request has to be the first thing the
// submit handler does, with no await in front of it. That is why this component
// calls `onPair` synchronously and leaves the permission ask to the caller's
// first statement rather than awaiting anything here.

import { useState } from 'react';
import { Button, Group, PasswordInput, SegmentedControl, Stack, TextInput } from '@mantine/core';

export type PairingMode = 'password' | 'code';

export type PairingParams =
  | { mode: 'password'; serverUrl: string; username: string; password: string; deviceName: string }
  | { mode: 'code'; serverUrl: string; code: string; deviceName: string };

export function PairingForm({
  initialServerUrl = '',
  busy = false,
  submitLabel = '登录并注册设备',
  onPair,
}: {
  initialServerUrl?: string;
  busy?: boolean;
  submitLabel?: string;
  onPair: (params: PairingParams) => void;
}) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [mode, setMode] = useState<PairingMode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const submit = () => {
    const trimmedUrl = serverUrl.trim();
    const trimmedName = deviceName.trim();
    if (mode === 'password') {
      onPair({ mode, serverUrl: trimmedUrl, username, password, deviceName: trimmedName });
      // The secret is the only field with no reason to survive the attempt: the
      // address and the device name describe what was just registered.
      setPassword('');
    } else {
      onPair({ mode, serverUrl: trimmedUrl, code: code.trim(), deviceName: trimmedName });
      // Same rule for the code: one-time, and spent by the attempt.
      setCode('');
    }
  };

  return (
    // lg, not sm: a hint now sits 4px under its own control, so the field above
    // and the label below need more than that to keep the hint attached.
    <Stack gap="lg">
      <TextInput
        label="服务器地址"
        description="扩展需要被允许访问该地址，浏览器会在点击后询问"
        placeholder="http://localhost:8080"
        value={serverUrl}
        onChange={(e) => setServerUrl(e.currentTarget.value)}
        required
      />
      <Stack gap="sm">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => setMode(v as PairingMode)}
          data={[
            { value: 'password', label: '账号密码' },
            { value: 'code', label: '配对码' },
          ]}
        />
        {mode === 'password' ? (
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              label="用户名"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              autoComplete="username"
              required
            />
            <PasswordInput
              label="密码"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoComplete="current-password"
              required
            />
          </Group>
        ) : (
          <TextInput
            label="配对码"
            description="在网页控制台「设备」页生成，10 分钟内有效，只能用一次；单点登录账号没有密码，配对码是唯一的配对方式"
            placeholder="例如：ABCD-2345"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            required
          />
        )}
      </Stack>
      <TextInput
        label="设备名称"
        description="这台浏览器在服务器上显示的名字，方便日后单独撤销它"
        placeholder="例如：工作电脑 Edge"
        value={deviceName}
        onChange={(e) => setDeviceName(e.currentTarget.value)}
      />
      {/* A Stack stretches its children; a full-width primary button on a form
          this narrow reads like a page-level action. */}
      <Button onClick={submit} loading={busy} style={{ alignSelf: 'flex-start' }}>
        {mode === 'code' ? '用配对码注册设备' : submitLabel}
      </Button>
    </Stack>
  );
}
