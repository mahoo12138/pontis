import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  TextInput,
  PasswordInput,
  Button,
  Divider,
  Group,
  Stack,
  Paper,
  Text,
  Alert,
  Anchor,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';
import { IconAlertCircle, IconCircleCheck, IconKey } from '@tabler/icons-react';
import { useLogin, useSystemStatus } from '../hooks/use-auth';
import { PontisLogo } from '../components/common/PontisLogo';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const loginMutation = useLogin();
  const { data: status } = useSystemStatus();
  // The SSO copy lives in the i18n auth namespace (the rest of this page
  // predates i18n and stays literal); unknown codes fall back to the generic
  // message rather than exposing a raw server code.
  const { t, i18n } = useTranslation();
  const oidcError = (code: string): string => {
    const key = `auth:oidc_error_${code.toLowerCase()}`;
    return i18n.exists(key) ? t(key) : '登录失败';
  };
  const [error, setError] = useState<string | null>(null);

  // Registration is offered only on a confirmed `open`; the bootstrap link
  // stays until the instance is confirmed initialized. The asymmetry is
  // deliberate: a status read that fails must never strand a fresh install
  // with no way in, and must never grant more access than it can confirm.
  const allowRegistration = status?.allow_registration ?? false;
  const showSetupLink = !status?.initialized;
  // The two login entries lean the same way. A failed status read keeps the
  // password form (a password instance must not be locked out by a hiccup)
  // and hides the SSO button (no promising a flow the server would refuse).
  const showPasswordForm = status ? status.password_login_enabled : true;
  const showSSO = status?.oidc_enabled ?? false;

  const oidcErrorCode = new URLSearchParams(location.search).get('error');
  useEffect(() => {
    if (!oidcErrorCode) return;
    // The OIDC callback reports failures by redirecting here with ?error=CODE;
    // one message each, in the page's own language rather than the server's —
    // the same stance the login form takes toward INVALID_CREDENTIALS.
    setError(oidcError(oidcErrorCode));
    // Strip the query so a refresh or a re-submit does not resurrect it.
    window.history.replaceState(null, '', location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oidcErrorCode, location.pathname]);

  const form = useForm({
    initialValues: { username: '', password: '' },
    validate: {
      username: (v) => (v.trim().length === 0 ? '请输入用户名' : null),
      password: (v) => (v.length === 0 ? '请输入密码' : null),
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    try {
      await loginMutation.mutateAsync(values);
      navigate('/');
    } catch (e: any) {
      // Neither of these belongs to one box: the server will not say which half
      // was wrong (that would tell someone which usernames exist), and a disabled
      // account is a fact about the account. So they stay with the form — but in
      // the page's own language rather than the server's.
      const code = (e as { code?: string } | undefined)?.code;
      setError(
        code === 'INVALID_CREDENTIALS'
          ? '用户名或密码错误'
          : code === 'ACCOUNT_DISABLED'
            ? '这个账号已被停用，请联系管理员'
            : code === 'PASSWORD_LOGIN_DISABLED'
              ? oidcError(code)
              : (e?.message ?? '登录失败'),
      );
    }
  });

  const justRegistered = Boolean((location.state as { registered?: boolean } | null)?.registered);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: 'var(--mantine-color-coolGray-0)',
    }}>
      <Paper shadow="sm" radius="md" p="xl" w={400}>
        <Stack gap="md">
          <Group gap="sm">
            <PontisLogo />
            <Text fz="lg" fw={600}>Pontis</Text>
          </Group>
          <Text fz="sm" c="dimmed">登录到你的书签工作空间</Text>

          {justRegistered && (
            <Alert icon={<IconCircleCheck size={16} />} color="healthyGreen" variant="light">
              账号已创建，用刚才的用户名登录。
            </Alert>
          )}

          {error && (
            <Alert icon={<IconAlertCircle size={16} />} color="errorRed" variant="light">
              {error}
            </Alert>
          )}

          {/* The SSO entry is a plain navigation, not a fetch: the server
              answers with a redirect to the provider, and the flow's cookies
              only ride on real navigations. */}
          {showSSO && (
            <Button
              component="a"
              href="/api/v1/auth/oidc/start"
              variant="default"
              fullWidth
              leftSection={<IconKey size={16} stroke={1.5} />}
            >
              使用 SSO 登录
            </Button>
          )}
          {showSSO && showPasswordForm && <Divider label="或" labelPosition="center" my="xs" />}

          {showPasswordForm && (
            <form onSubmit={handleSubmit}>
              <Stack gap="sm">
                <TextInput
                  label="用户名"
                  placeholder="admin"
                  {...form.getInputProps('username')}
                />
                <PasswordInput
                  label="密码"
                  placeholder="输入密码"
                  {...form.getInputProps('password')}
                />
                <Button type="submit" loading={loginMutation.isPending} fullWidth mt="xs">
                  登录
                </Button>
              </Stack>
            </form>
          )}

          {allowRegistration && showPasswordForm && (
            <Text fz="xs" c="dimmed" ta="center">
              还没有账号？<Anchor fz="xs" component={Link} to="/register">创建账号</Anchor>
            </Text>
          )}
          {showSetupLink && (
            <Text fz="xs" c="dimmed" ta="center">
              首次使用？<Anchor fz="xs" component={Link} to="/setup">初始化新实例</Anchor>
            </Text>
          )}
        </Stack>
      </Paper>
    </div>
  );
}
