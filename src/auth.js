import {
  createJWT,
  createOtpUri,
  generateOtpSecret,
  hashPassword,
  jsonResponse,
  parseCookies,
  requireRequiredConfig,
  verifyJWT,
  verifyTotp
} from './common.js';

// ============================================================================
// AUTHENTICATION HANDLERS
// ============================================================================

async function handleLogin(request, env) {
  try {
    requireRequiredConfig(env, ['ADMIN_PASSWORD', 'KV_STORE', 'D1_DB']);
    const body = await request.json().catch(() => ({}));
    const isAdmin = body.isAdmin !== false && body.isAdmin !== 'false';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!password) {
      return jsonResponse({ success: false, message: '请输入密码' }, 400);
    }

    if (isAdmin) {
      if (password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ success: false, message: '密码错误' }, 401);
      }

      const otpSecretKey = 'admin:otp:secret';
      const pendingOtpKey = 'admin:otp:pending';
      let otpSecret = await env.KV_STORE.get(otpSecretKey);
      const otp = typeof body.otp === 'string' ? body.otp.trim() : '';

      if (!otpSecret) {
        otpSecret = await env.KV_STORE.get(pendingOtpKey);
        if (!otpSecret) {
          otpSecret = generateOtpSecret();
          await env.KV_STORE.put(pendingOtpKey, otpSecret);
        }

        if (!otp || !(await verifyTotp(otpSecret, otp))) {
          return jsonResponse({
            success: false,
            requiresOtpSetup: true,
            otpSecret,
            otpUri: createOtpUri(otpSecret),
            message: otp ? 'OTP 验证码错误，请重试' : '请扫码绑定 OTP 后输入验证码'
          }, otp ? 401 : 200);
        }

        await env.KV_STORE.put(otpSecretKey, otpSecret);
        await env.KV_STORE.delete(pendingOtpKey);
      } else if (!otp || !(await verifyTotp(otpSecret, otp))) {
        return jsonResponse({
          success: false,
          requiresOtp: true,
          message: otp ? 'OTP 验证码错误' : '请输入 OTP 验证码'
        }, 401);
      }

      const token = await createJWT(
        { role: 'admin', exp: Date.now() + 24 * 60 * 60 * 1000 },
        env.ADMIN_PASSWORD
      );
      return jsonResponse(
        { success: true, role: 'admin' },
        200,
        { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` }
      );
    }

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email) {
      return jsonResponse({ success: false, message: '请输入邮箱' }, 400);
    }

    const rawUser = await env.KV_STORE.get(`user:${email}`);
    if (!rawUser) {
      return jsonResponse({ success: false, message: '邮箱或密码错误' }, 401);
    }

    let user;
    try {
      user = JSON.parse(rawUser);
    } catch {
      user = null;
    }
    const passwordHash = user?.passwordHash ? await hashPassword(password) : '';
    if (!user || passwordHash !== user.passwordHash) {
      return jsonResponse({ success: false, message: '邮箱或密码错误' }, 401);
    }

    const token = await createJWT(
      { role: 'user', email: user.email || email, exp: Date.now() + 24 * 60 * 60 * 1000 },
      env.ADMIN_PASSWORD
    );
    return jsonResponse(
      { success: true, role: 'user', email: user.email || email },
      200,
      { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` }
    );
  } catch (e) {
    return jsonResponse({ success: false, message: '登录失败: ' + e.message }, 500);
  }
}

async function handleLogout() {
  return jsonResponse(
    { success: true },
    200,
    { 'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }
  );
}

async function verifyAuth(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.token;

  if (!token) return null;

  return await verifyJWT(token, env.ADMIN_PASSWORD);
}

async function requireAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }
  return auth;
}

async function requireAdmin(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth || auth.role !== 'admin') {
    return jsonResponse({ success: false, message: '需要管理员权限' }, 403);
  }
  return auth;
}
export { handleLogin, handleLogout, verifyAuth, requireAuth, requireAdmin };
