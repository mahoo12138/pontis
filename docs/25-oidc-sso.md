# 25. OIDC 单点登录(SSO)

> 文档状态:已实现(与 server/internal/auth/oidc.go、httpapi/oidc.go 对应)
> 更新时间:2026-11-07

## 1. 目标与边界

Pontis 接入任意标准 OIDC 提供方(Casdoor、Keycloak、Authentik、Auth0 等)作为登录方式:

- Server 是一个普通 OIDC Relying Party:discovery + Authorization Code Flow + PKCE(S256)。
- **OIDC token 永远不进浏览器 JS**。回调在服务端完成验签与换取,唯一产物是一条普通的 web session(`pontis_session` cookie),与密码登录同构。前端只多一个"使用 SSO 登录"入口和错误码映射。
- 不做:IdP 角色/组到 Pontis admin 的映射;refresh token 续期;RP/Back-channel logout;多 IdP 并存;管理后台在线编辑 IdP 配置。这些都留给后续迭代。

## 2. 配置(部署面,不是产品面)

OIDC 配置在 TOML `[oidc]` 段或 `PONTIS_OIDC_*` 环境变量,与 `public_url` 同级——它是部署级事实(redirect URI 由 public_url 决定),且 client_secret 不应进数据库。产品面(`system_settings`)继续只放注册模式这类运营开关。

```toml
[oidc]
enabled = false
issuer_url = ""              # Casdoor 例:https://sso.example.com
client_id = ""
client_secret = ""
scopes = ["openid", "profile", "email"]   # 留空即此默认
auto_provision = true        # 首次登录的未知身份自动建号(role=user)
disable_password_login = false
```

约束(validate 在启动时强制):

- `enabled = true` 时 issuer_url / client_id / client_secret 必填;discovery 在启动时执行,**配置错误让进程起不来**,而不是在第一次登录时才发现。
- `disable_password_login = true` 必须 `enabled = true`(否则等于把所有账号锁在门外)。

### Casdoor 对接示例

1. Casdoor 后台新建 Application,Redirect URL 填 `{public_url}/api/v1/auth/oidc/callback`。
2. `issuer_url` 填 Casdoor 的 endpoint(其 discovery 在 `{endpoint}/.well-known/openid-configuration`)。
3. 确认测试用户在 Casdoor 里邮箱属性已标记 verified——email 关联只信任 `email_verified: true`(见 §4)。

## 3. 端点与流程

```text
浏览器                    Pontis Server                         IdP
  │ GET /api/v1/auth/oidc/start
  │──────────────────────────▶│
  │                           │ 生成 state token + PKCE verifier + nonce
  │                           │ oidc_auth_states 落一行(哈希为键,10 分钟)
  │◀── 302 IdP/authorize ─────│  (Set-Cookie: pontis_oidc=state; HttpOnly; Lax)
  │──────────────────────────────────────────────────────────────────▶│
  │◀────────────── 302 /api/v1/auth/oidc/callback?code&state ────────│
  │ GET callback              │
  │──────────────────────────▶│ 原子消费 state 行(单次、10 分钟)
  │                           │ code + verifier 换 token
  │                           │ 验 ID token:签名/iss/aud/exp + nonce 比对
  │                           │ 解析账号(§4)→ 签发普通 session
  │◀── 302 return_to 或 / ────│ (Set-Cookie: pontis_session; 清 oidc cookie)
```

- state token 同时出现在 authorize URL 与 HttpOnly cookie 里,服务端比对两者并**原子消费**(照 `password_reset_tokens` 的纪律:SELECT + guarded DELETE 同事务,两个并发回调只有一个赢家)。flow state 落库存而不放加密 cookie,是为了单次性与过期语义和仓库里其它一次性 secret 完全一致。
- 提供方自己的拒绝(`error=` 参数)与服务端失败都收敛为 `302 /login?error=<CODE>`;稳定码:`OIDC_UNAVAILABLE / OIDC_STATE_INVALID / OIDC_TOKEN_EXCHANGE / OIDC_TOKEN_INVALID / OIDC_PROVIDER_DENIED / OIDC_ACCOUNT_NOT_LINKED / OIDC_NOT_INITIALIZED / OIDC_PROVISION_FAILED / OIDC_ACCOUNT_DISABLED / OIDC_INTERNAL`。
- `return_to` 只接受本应用路径(`/` 开头且非 `//`、`/\`、无 scheme),否则落回 `/`——callback 不是开放重定向器。
- redirect URI 逐请求推导(`public_url` 优先,否则请求 Host,与 reset link 同规则),并随 state 行落库,保证 authorize 与 exchange 两跳用同一个值。

## 4. 账号解析(防接管是第一优先级)

对验证过的 (issuer, subject):

1. **identity 行决定**:`oidc_identities(issuer, subject)` → user。这是唯一持久的绑定;IdP 改邮箱不会让身份换主。
2. **email 关联(仅 bootstrap)**:identity 不存在且 `email` claim 存在**且 `email_verified: true`** 时,仅当本地账号同时满足 `email_verified_at IS NOT NULL`（仅由管理员建号、首次初始化或已验证 SSO 开通写入；开放注册或自助修改邮箱时置空）且尚未绑定该 issuer 的其他 subject，才按 `email_normalized` 关联并写入 identity 行。未验证的 IdP claim 或本地自填邮箱永不参与关联。
3. **自动开通**:`auto_provision = true` 时创建 role=user 账号(password_hash 为空 → 密码登录天然失败;默认 Personal space 由 HTTP 层与 /auth/register 同一钩子补齐);`false` 时拒绝(`OIDC_ACCOUNT_NOT_LINKED`)。

两个附加红线:

- **实例未初始化(users=0)时 SSO 拒绝建号**(`OIDC_NOT_INITIALIZED`)。第一个账号必须是 /auth/setup 的 admin,SSO 永远不能成为通向 admin 角色的路径。
- **未验证的 email 不落库**。若用它建号,该邮箱槽位即被投毒:攻击者可以先拿别人的邮箱在自家 IdP 上"未验证"建号,等受害者用已验证 email 的 IdP 登录时被关联到攻击者的账号。所以 provisioning 时未验证 email 一律存空;email 已被占用且未验证时直接失败,不做"关联到已存在账号"的兜底。

username 取 preferred_username(过滤到本产品字符集,不足 3 字符回退 email local part、再回退 `sso`),冲突时依序试 `name-2`、`name-3`…(上限 8 次)。

## 5. 纯 SSO 部署

`disable_password_login = true` 时:

- `POST /auth/login`、`/auth/register`、`/auth/reset` 一律 403 `PASSWORD_LOGIN_DISABLED`;
- `GET /system/status` 的 `password_login_enabled = false`,登录页隐藏密码表单与注册链接(SSO 按钮 `oidc_enabled` 同源展示);
- **/auth/setup 不门禁**:未初始化的实例必须始终能铸出第一个 admin。

锁定风险:IdP 不可用时唯一解锁路径是改配置重启。这是部署者显式选择的交换,配置注释里写明。

## 6. 设备配对码(扩展侧的 SSO 桥)

扩展按设计**绝不持有 web session**(doc 09 §11),配对原本要求在扩展里输入账号密码。这有两个问题:密码进了扩展表单;SSO 自动开通的账号根本没有密码。

解法是配对码桥:

- 已登录的 Web 控制台「设备」页 → `POST /api/v1/devices/pairing-codes`(requireSession)→ 一次性 8 位码(`XXXX-XXXX`,Crockford 式字母表,无 0/O/1/I/L),仅存 SHA-256 hash,10 分钟。
- 扩展登录界面选"配对码"模式 → `POST /api/v1/devices/pair`(公开,码即凭证)→ 响应与 `POST /devices` 同构(`{device, token}`),扩展侧走同一条 bootstrap 存储路径。
- 消费是原子的(reset token 同款事务):码在设备创建**之前**烧掉;兑换失败重取新码即可,已用过的码永不再有效。

## 7. 威胁模型备注

| 面 | 对策 |
|---|---|
| code 注入 / 流混用 | state 双通道比对 + 服务端单次消费 + PKCE(S256) |
| ID token 重放 | nonce 绑定本 flow,常数时间比对 |
| email 接管 | 仅 `email_verified` 关联;未验证 email 不落库;identity(subject)优先于一切 |
| 开放重定向 | return_to 白名单式校验(仅本应用路径) |
| 首账号提权 | users=0 时 SSO 拒绝建号 |
| 流状态伪造 | 浏览器只持随机 state token,verifier/nonce 从不离开服务端 |

## 8. 测试

- Go 集成测试(`server/internal/httpapi/oidc_test.go`):httptest stub IdP(真 discovery/真 JWKS/真 RS256),覆盖自动开通、email 关联与 subject 记忆、未验证 email 拒关联、auto_provision 关闭、state 重放、nonce/签名破坏、disable_password_login 全门禁 + setup 例外、配对码全生命周期(兑换/复用/归一化/过期)。
- Web e2e(ch13):stub IdP 下真实浏览器走完 start → IdP → callback → 登录全链路;配对码在设备页生成、API 兑换、单次性断言。
