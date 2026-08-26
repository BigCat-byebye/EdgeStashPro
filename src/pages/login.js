import { CSS_STYLES } from './styles.js';
import { THEME_BOOTSTRAP, THEME_TOGGLE_BUTTON } from './theme.js';

const FIXED_LOGIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="theme-toggle-floating">${THEME_TOGGLE_BUTTON}</div>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">EdgeStashPro</div>
        <div class="login-subtitle">基于 Cloudflare 的云盘服务</div>
      </div>

      <div class="login-tabs">
        <button type="button" class="login-tab active" onclick="switchLoginTab('admin')">管理员登录</button>
        <button type="button" class="login-tab" onclick="switchLoginTab('user')">用户登录</button>
      </div>

      <form id="loginForm" onsubmit="handleLogin(event)">
        <div id="emailField" class="form-group" style="display: none;">
          <label class="form-label" for="email">邮箱</label>
          <input type="email" id="email" class="form-input" placeholder="请输入邮箱">
        </div>

        <div class="form-group">
          <label class="form-label" for="password">密码</label>
          <input type="password" id="password" class="form-input" placeholder="请输入密码" required>
        </div>

        <div id="otpField" class="form-group">
          <label class="form-label" for="otp">OTP 验证码</label>
          <input type="text" id="otp" class="form-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码">
        </div>

        <div id="otpSetupPanel" class="form-group" style="display: none;">
          <label class="form-label">首次绑定管理员 OTP</label>
          <div class="qr-panel">
            <canvas id="otpQrCanvas" width="180" height="180" aria-label="管理员 OTP 二维码"></canvas>
          </div>
          <input type="text" id="otpSecret" class="form-input" readonly>
        </div>

        <button type="submit" class="btn btn-primary" style="width: 100%;">登录</button>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let isAdminLogin = true;

    function switchLoginTab(type) {
      isAdminLogin = type === 'admin';
      const tabs = document.querySelectorAll('.login-tab');
      tabs[0].classList.toggle('active', isAdminLogin);
      tabs[1].classList.toggle('active', !isAdminLogin);
      document.getElementById('emailField').style.display = isAdminLogin ? 'none' : 'block';
      document.getElementById('otpField').style.display = isAdminLogin ? 'block' : 'none';
      document.getElementById('otpSetupPanel').style.display = 'none';
    }

    async function handleLogin(event) {
      event.preventDefault();

      const password = document.getElementById('password').value;
      const email = document.getElementById('email').value.trim();
      const otp = document.getElementById('otp').value.trim();

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isAdmin: isAdminLogin,
            email: isAdminLogin ? undefined : email,
            password,
            otp: isAdminLogin ? otp : undefined
          })
        });

        const data = await response.json().catch(function () {
          return { success: false, message: '服务返回异常，请检查 Worker 日志和绑定配置' };
        });
        if (data.success) {
          showToast('登录成功', 'success');
          window.setTimeout(function () {
            window.location.href = '/';
          }, 300);
        } else if (data.requiresOtpSetup) {
          document.getElementById('otpSetupPanel').style.display = 'block';
          document.getElementById('otpSecret').value = data.otpSecret || '';
          if (data.otpUri) renderOtpQr(data.otpUri);
          showToast(data.message || '请扫码绑定 OTP 后输入验证码', 'info');
        } else if (data.requiresOtp) {
          document.getElementById('otpField').style.display = 'block';
          showToast(data.message || '请输入 OTP 验证码', 'error');
        } else {
          showToast(data.message || '登录失败', 'error');
        }
      } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
      }
    }

    function renderOtpQr(text) {
      const canvas = document.getElementById('otpQrCanvas');
      if (!canvas) return;
      try {
        const qr = createQrMatrix(text);
        const ctx = canvas.getContext('2d');
        const quiet = 4;
        const scale = Math.max(1, Math.floor(canvas.width / (qr.size + quiet * 2)));
        const imageSize = (qr.size + quiet * 2) * scale;
        const offset = Math.floor((canvas.width - imageSize) / 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.matrix[y][x]) {
              ctx.fillRect(offset + (x + quiet) * scale, offset + (y + quiet) * scale, scale, scale);
            }
          }
        }
      } catch {
        showToast('二维码生成失败，请手动输入 Secret', 'error');
      }
    }

    function createQrMatrix(text) {
      const version = 6;
      const size = 17 + version * 4;
      const dataCodewords = 136;
      const blockCount = 2;
      const blockDataCodewords = 68;
      const eccCodewords = 18;
      const bytes = Array.from(new TextEncoder().encode(text));
      const bits = [];

      function pushBits(value, length) {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
      }

      if (bytes.length > dataCodewords - 3) throw new Error('QR payload too long');
      pushBits(4, 4);
      pushBits(bytes.length, 8);
      bytes.forEach(function (byte) { pushBits(byte, 8); });

      const capacityBits = dataCodewords * 8;
      for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
        data.push(value);
      }
      for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad);

      const blocks = [];
      for (let block = 0; block < blockCount; block++) {
        const blockData = data.slice(block * blockDataCodewords, (block + 1) * blockDataCodewords);
        blocks.push({ data: blockData, ecc: reedSolomonCompute(blockData, eccCodewords) });
      }

      const codewords = [];
      for (let i = 0; i < blockDataCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].data[i]);
      }
      for (let i = 0; i < eccCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].ecc[i]);
      }

      const matrix = Array.from({ length: size }, function () { return Array(size).fill(false); });
      const isFunction = Array.from({ length: size }, function () { return Array(size).fill(false); });

      function setModule(x, y, dark, func) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        matrix[y][x] = !!dark;
        if (func) isFunction[y][x] = true;
      }

      function drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist !== 2 && dist <= 3, true);
          }
        }
      }

      function drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist === 2 || dist === 0, true);
          }
        }
      }

      function drawFormat(mask) {
        const bits = getFormatBits(1, mask);
        for (let i = 0; i <= 5; i++) setModule(8, i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, 7, ((bits >>> 6) & 1) !== 0, true);
        setModule(8, 8, ((bits >>> 7) & 1) !== 0, true);
        setModule(7, 8, ((bits >>> 8) & 1) !== 0, true);
        for (let i = 9; i < 15; i++) setModule(14 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 0; i < 8; i++) setModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 8; i < 15; i++) setModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, size - 8, true, true);
      }

      drawFinder(3, 3);
      drawFinder(size - 4, 3);
      drawFinder(3, size - 4);
      for (let i = 8; i < size - 8; i++) {
        setModule(6, i, i % 2 === 0, true);
        setModule(i, 6, i % 2 === 0, true);
      }
      drawAlignment(34, 34);
      drawFormat(0);

      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vertical = 0; vertical < size; vertical++) {
          const y = upward ? size - 1 - vertical : vertical;
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            if (isFunction[y][x]) continue;
            let dark = false;
            if (bitIndex < codewords.length * 8) {
              dark = ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0;
            }
            bitIndex++;
            if ((x + y) % 2 === 0) dark = !dark;
            setModule(x, y, dark, false);
          }
        }
        upward = !upward;
      }
      drawFormat(0);
      return { size: size, matrix: matrix };
    }

    function getFormatBits(ecl, mask) {
      let data = (ecl << 3) | mask;
      let bits = data << 10;
      for (let i = 14; i >= 10; i--) {
        if (((bits >>> i) & 1) !== 0) bits ^= 0x537 << (i - 10);
      }
      return ((data << 10) | bits) ^ 0x5412;
    }

    function reedSolomonCompute(data, degree) {
      const divisor = Array(degree).fill(0);
      divisor[degree - 1] = 1;
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
          divisor[j] = gfMultiply(divisor[j], root);
          if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
        }
        root = gfMultiply(root, 2);
      }

      const result = Array(degree).fill(0);
      data.forEach(function (byte) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(divisor[i], factor);
      });
      return result;
    }

    function gfMultiply(x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) z ^= x;
      }
      return z & 0xff;
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }
  </script>
</body>
</html>
`;
export { FIXED_LOGIN_PAGE };
