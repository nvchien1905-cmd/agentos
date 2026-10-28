'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// /dongbo — SAO LƯU HAI CHIỀU dữ liệu Claude + Codex giữa máy đầu não và các máy con trong Đội máy, qua SSH (sau /ketnoi), không cần AI.
//   - KÉO: lấy dữ liệu của máy con về máy này: <thư mục sao lưu>/<tên máy>/<ngày-giờ>.tar.gz (kiểm lại tệp nén trước khi tính là xong)
//   - ĐẨY: gửi dữ liệu của máy này sang máy con: <thư mục người dùng>\AgentOS-saoluu\<tên máy này>\<ngày-giờ>\ (Linux: /var/lib/agentos-saoluu/...)
//   Mỗi lần là MỘT BẢN RIÊNG theo thời điểm (không ghi đè, không chép lệnh xóa sang bên kia), giữ `keep` bản gần nhất mỗi chiều.
//   KHÔNG sao chép tệp đăng nhập/khóa (.credentials.json, auth.json): mỗi máy tự đăng nhập, sao chép token sang máy khác dễ làm hỏng phiên.
// Tự chạy: mỗi 10 phút kiểm; máy nào bật "tự động" và đã quá `everyHours` giờ từ lần xong gần nhất, đang liên lạc được thì sao lưu (lỗi thì thử lại sau 30 phút).
const NAMES = ['.claude', '.codex', '.claude.json'];
const EXCLUDES = ['.credentials.json', 'auth.json'];
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'may';
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()); };
const fmtSize = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// Nối đầu ra của tiến trình/tệp `src` vào đầu vào của `dst`. src/dst: { bin, args } hoặc { file } (ghi/đọc tệp). Trả { ok, bytes, err }.
function pipeProcs(src, dst) {
  return new Promise((resolve) => {
    let bytes = 0, errA = '', errB = '', codeA = null, codeB = null, pending = 2, finished = false;
    const step = () => {
      if (--pending > 0 || finished) return;
      finished = true;
      const ok = codeA === 0 && (dst.file ? true : codeB === 0);
      resolve({ ok, bytes, err: (errB || errA || '').trim().split('\n').pop() || (ok ? '' : 'lệnh kết thúc với mã ' + (codeA !== 0 ? codeA : codeB)) });
    };
    const a = spawn(src.bin, src.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    a.stderr.on('data', (d) => { errA = (errA + d).slice(-1500); });
    a.stdout.on('data', (d) => { bytes += d.length; });
    a.on('error', (e) => { errA = e.message; codeA = 1; step(); if (dst.file) { try { out.end(); } catch (x) { /* đã đóng */ } } else { try { b.stdin.end(); } catch (x) { /* đã đóng */ } } });
    a.on('close', (c) => { if (codeA === null) codeA = c; step(); });
    let out = null, b = null;
    if (dst.file) {                                       // chỉ tính xong khi tệp đã GHI HẾT và đóng (không để bản cụt)
      out = fs.createWriteStream(dst.file, { mode: 0o600 });
      out.on('error', (e) => { errB = e.message; codeB = 1; });
      out.on('close', () => step());
      a.stdout.pipe(out);
    } else {
      b = spawn(dst.bin, dst.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      b.stderr.on('data', (d) => { errB = (errB + d).slice(-1500); });
      b.stdout.on('data', () => {});
      b.stdin.on('error', () => {});
      b.on('error', (e) => { errB = e.message; codeB = 1; step(); });
      b.on('close', (c) => { if (codeB === null) codeB = c; step(); });
      a.stdout.pipe(b.stdin);
    }
  });
}

function createDongBo(o) {
  const { fleet, notify, log } = o;
  const logf = log || (() => {});
  const keyDir = o.keyDir || '/var/lib/agentos/.ssh';
  const baseDir = o.baseDir || '/var/lib/agentos/saoluu-may';           // nơi giữ bản KÉO về
  const file = o.file || '/var/lib/agentos/data/dongbo.json';
  const localHome = o.localHome || process.env.HOME || '/var/lib/agentos';
  const myName = safeName(o.myName || require('os').hostname());
  const tarBin = o.tarBin || 'tar';
  const keep = o.keep || 7, every = o.everyHours || 6, now = o.now || Date.now;
  const run = o.run || ((bin, args, opt) => new Promise((resolve) => execFile(bin, args, { timeout: (opt && opt.timeout) || 60000, maxBuffer: 8 * 1024 * 1024 }, (err, out, e) => resolve({ ok: !err, out: String(out || ''), err: String(e || (err && err.message) || '') }))));
  const pipe = o.pipe || pipeProcs;
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { machines: {} }; } };
  const save = (c) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 1)); fs.renameSync(t, file); };
  const sshBase = (m) => ['-i', path.join(keyDir, 'id_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(keyDir, 'known_hosts'), '-o', 'ConnectTimeout=10', m.ssh.user + '@' + new URL(m.url).hostname];
  const ssh = (m, cmd) => ({ bin: 'ssh', args: sshBase(m).concat([cmd]) });
  const excl = EXCLUDES.map((e) => '--exclude=' + e);

  async function platformOf(m) { try { const s = await fleet.call(m, 'GET', '/fleet/status', undefined, 6000); return s && s.platform === 'windows' ? 'windows' : 'linux'; } catch (e) { return null; } }

  // Những mục dữ liệu AI có thật trên máy con
  async function remoteNames(m, plat) {
    const cmd = plat === 'windows'
      ? 'for %i in (' + NAMES.join(' ') + ') do @if exist "%USERPROFILE%\\%i" echo %i'
      : "sudo -n sh -c 'for i in " + NAMES.join(' ') + "; do [ -e /var/lib/agentos/$i ] && echo $i; done'";
    const r = await run('ssh', sshBase(m).concat([cmd]));
    if (!r.ok) throw new Error('không SSH vào được: ' + (r.err.trim().split('\n').pop() || 'không rõ lý do'));
    return r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => NAMES.includes(l));
  }
  function localNames() { return NAMES.filter((n) => { try { fs.statSync(path.join(localHome, n)); return true; } catch (e) { return false; } }); }

  // Chiều KÉO: máy con -> máy này
  async function pull(name, m, plat) {
    const names = await remoteNames(m, plat);
    if (!names.length) return { skipped: 'máy con chưa có dữ liệu Claude/Codex', bytes: 0 };
    const cmd = plat === 'windows' ? 'tar -czf - -C "%USERPROFILE%" ' + excl.join(' ') + ' ' + names.join(' ') : 'sudo -n tar -czf - -C /var/lib/agentos ' + excl.join(' ') + ' ' + names.join(' ');
    const dir = path.join(baseDir, safeName(name)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = path.join(dir, stamp(new Date(now())) + '.tar.gz'), part = out + '.part';
    const r = await pipe(ssh(m, cmd), { file: part });
    if (!r.bytes) { try { fs.rmSync(part, { force: true }); } catch (e) { /* đã mất */ } throw new Error('kéo về lỗi: ' + (r.err || 'không nhận được dữ liệu')); }
    // tar thoát với mã lỗi nhưng vẫn ra bản nén đọc được = chỉ có vài tệp đang bị chương trình khác giữ (vd. nhật ký Codex đang mở) bị bỏ qua
    const skipped = r.ok ? '' : String(r.err || '').replace(/^tar: /, '');
    const t = await run(tarBin, ['-tzf', part], { timeout: 120000 });                                       // kiểm tệp nén đọc được trước khi tính là xong
    if (!t.ok) { try { fs.rmSync(part, { force: true }); } catch (e) { /* đã mất */ } throw new Error('bản kéo về bị hỏng (không giải nén được)'); }
    if (!r.ok && !/Permission denied|Couldn't open|Cannot open|can't open|Error exit delayed/i.test(r.err || '')) { try { fs.rmSync(part, { force: true }); } catch (e) { /* đã mất */ } throw new Error('kéo về lỗi: ' + r.err); }
    fs.renameSync(part, out);
    const old = fs.readdirSync(dir).filter((f) => /\.tar\.gz$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* bỏ qua */ } }
    return { file: out, bytes: r.bytes, warn: skipped ? 'có tệp đang mở nên bị bỏ qua' : '' };
  }

  // Chiều ĐẨY: máy này -> máy con
  async function push(name, m, plat) {
    const names = localNames();
    if (!names.length) return { skipped: 'máy này chưa có dữ liệu Claude/Codex', bytes: 0 };
    const ts = stamp(new Date(now()));
    const src = { bin: tarBin, args: ['-czf', '-', '-C', localHome].concat(excl, names) };
    let cmd, prune;
    if (plat === 'windows') {
      const base = '%USERPROFILE%\\AgentOS-saoluu\\' + myName, dst = base + '\\' + ts;
      cmd = 'mkdir "' + dst + '" 2>nul & tar -xzf - -C "' + dst + '"';
      prune = 'powershell -NoProfile -NonInteractive -Command "Get-ChildItem (Join-Path $env:USERPROFILE \'AgentOS-saoluu\\' + myName + '\') -Directory | Sort-Object Name -Descending | Select-Object -Skip ' + keep + ' | Remove-Item -Recurse -Force"';
    } else {
      const base = '/var/lib/agentos-saoluu/' + myName, dst = base + '/' + ts;
      cmd = "sudo -n sh -c 'mkdir -p " + dst + " && tar -xzf - -C " + dst + "'";
      prune = "sudo -n sh -c 'ls -1d " + base + "/*/ 2>/dev/null | sort -r | tail -n +" + (keep + 1) + " | xargs -r rm -rf'";
    }
    const r = await pipe(src, ssh(m, cmd));
    if (!r.ok || !r.bytes) throw new Error('đẩy sang lỗi: ' + (r.err || 'không gửi được dữ liệu'));
    await run('ssh', sshBase(m).concat([prune]));                                                           // dọn bản cũ (lỗi dọn không làm hỏng bản vừa gửi)
    return { bytes: r.bytes };
  }

  // Chạy MỘT lần cả hai chiều cho một máy. Trả văn bản báo kết quả.
  const busy = new Set();
  async function syncOne(name) {
    let m = fleet.findMachine(name); if (!m) throw new Error('Không có máy "' + name + '" trong Đội máy.');
    if ((!m.ssh || !m.ssh.user) && o.ensureSsh) { try { await o.ensureSsh(m.name); } catch (e) { /* báo lỗi bên dưới */ } m = fleet.findMachine(name); }
    if (!m.ssh || !m.ssh.user) throw new Error('Chưa SSH được vào "' + m.name + '": gõ /ketnoi trước.');
    if (busy.has(m.name)) throw new Error('"' + m.name + '" đang được sao lưu.');
    busy.add(m.name);
    const c = load(); c.machines[m.name] = c.machines[m.name] || {}; const st = c.machines[m.name];
    try {
      const plat = await platformOf(m); if (!plat) throw new Error('máy không trả lời (đang tắt hoặc mất mạng)');
      const lines = []; let okAny = false, err = '';
      for (const [label, fn] of [['⬇️ Kéo về từ ' + m.name, pull], ['⬆️ Đẩy sang ' + m.name, push]]) {
        try { const r = await fn(m.name, m, plat); okAny = true; lines.push(r.skipped ? '➖ ' + label + ': ' + r.skipped : '✅ ' + label + ': ' + fmtSize(r.bytes) + (r.warn ? ' (' + r.warn + ')' : '')); st[fn === pull ? 'pullBytes' : 'pushBytes'] = r.bytes; }
        catch (e) { err = err || e.message; lines.push('❌ ' + label + ': ' + e.message); }
      }
      st.lastTry = now();
      if (!err) { st.lastOk = now(); st.fails = 0; st.lastErr = ''; } else { st.fails = (st.fails || 0) + 1; st.lastErr = err; }
      save(c); logf('dongbo ' + m.name + ': ' + (err ? 'lỗi — ' + err : 'xong'));
      return { text: lines.join('\n'), ok: !err && okAny, err, fails: st.fails || 0, first: !err && !st.notified };
    } finally { busy.delete(m.name); }
  }

  // ----- lệnh cho bot -----
  function setAuto(names, on, hours) {
    const c = load(); const list = names.length ? names : fleet.load().machines.map((m) => m.name); const out = [];
    for (const n of list) { const m = fleet.findMachine(n); if (!m) { out.push('Không có máy "' + n + '".'); continue; } c.machines[m.name] = Object.assign(c.machines[m.name] || {}, { enabled: on }, hours ? { everyHours: hours } : {}); out.push((on ? '✅ Tự động sao lưu 2 chiều: BẬT cho "' : '⏸ Tự động sao lưu: TẮT cho "') + m.name + '"' + (on ? ' (mỗi ' + ((c.machines[m.name].everyHours) || every) + ' giờ, và ngay khi máy bật/nối lại mạng)' : '')); }
    save(c); return out.join('\n');
  }
  function status() {
    const c = load(), ms = fleet.load().machines;
    if (!ms.length) return 'Chưa có máy con nào trong Đội máy. Gõ /ketnoi để kết nối.';
    const ago = (t) => { if (!t) return 'chưa lần nào'; const m = Math.round((now() - t) / 60000); return m < 1 ? 'vừa xong' : m < 90 ? m + ' phút trước' : m < 2880 ? Math.round(m / 60) + ' giờ trước' : Math.round(m / 1440) + ' ngày trước'; };
    return '💾 Sao lưu 2 chiều Claude/Codex:\n' + ms.map((m) => { const s = c.machines[m.name] || {}; return (s.enabled ? '🟢 ' : '⚪ ') + m.name + ' · ' + (s.enabled ? 'tự động mỗi ' + (s.everyHours || every) + ' giờ' : 'chưa bật tự động') + ' · xong gần nhất: ' + ago(s.lastOk) + (s.lastErr ? ' · ⚠️ ' + s.lastErr : '') + (m.ssh && m.ssh.user ? '' : ' · chưa SSH (gõ /ketnoi)'); }).join('\n') +
      '\nBản KÉO về lưu ở ' + baseDir + '/<tên máy>/ (giữ ' + keep + ' bản). Bật: /dongbo bat · Tắt: /dongbo tat · Chạy ngay: /dongbo chay [tên máy]';
  }
  async function command(arg) {
    const t = String(arg || '').trim(); const m = /^(\S+)\s*([\s\S]*)$/.exec(t); const sub = m ? m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd') : '';
    if (!t) return status();
    if (sub === 'bat' || sub === 'tat') { const rest = m[2].trim(); const hm = /^(.*?)(?:\s+(\d{1,3}))?\s*$/.exec(rest); const nm = /^\d+$/.test(rest) ? '' : (hm[1] || '').trim(); const hrs = hm[2] ? Number(hm[2]) : (/^\d+$/.test(rest) ? Number(rest) : 0); return setAuto(nm ? [nm] : [], sub === 'bat', hrs >= 1 && hrs <= 168 ? hrs : 0); }
    const name = sub === 'chay' || sub === 'ngay' ? m[2].trim() : t;
    const targets = name ? [name] : fleet.load().machines.map((x) => x.name);
    if (!targets.length) return 'Chưa có máy con nào trong Đội máy. Gõ /ketnoi để kết nối.';
    const parts = [];
    for (const n of targets) { try { const r = await syncOne(n); parts.push('💾 ' + n + '\n' + r.text); } catch (e) { parts.push('💾 ' + n + '\n⚠️ ' + e.message); } }
    return parts.join('\n\n');
  }

  // ----- tự chạy -----
  async function tick() {
    const c = load(); const t = now();
    for (const m of fleet.load().machines) {
      const s = c.machines[m.name]; if (!s || !s.enabled || !m.ssh || !m.ssh.user) continue;
      const due = !s.lastOk || t - s.lastOk >= (s.everyHours || every) * 3600000;
      const retryOk = !s.lastTry || s.lastTry <= (s.lastOk || 0) || t - s.lastTry >= 1800000;           // lỗi thì 30 phút sau thử lại
      if (!due || !retryOk) continue;
      try {
        const r = await syncOne(m.name);
        const c2 = load(); const st = c2.machines[m.name] || (c2.machines[m.name] = {});
        if (r.ok && !st.notified) { st.notified = true; save(c2); if (notify) await notify('💾 Sao lưu 2 chiều "' + m.name + '" chạy được lần đầu:\n' + r.text); }
        else if (!r.ok && r.fails === 3 && notify) await notify('⚠️ Sao lưu 2 chiều "' + m.name + '" lỗi 3 lần liên tiếp: ' + r.err + '\nBot sẽ tiếp tục thử lại. Xem: /dongbo');
      } catch (e) { /* máy tắt/mất mạng: lần tới thử lại, không báo ồn */ }
    }
  }
  return { command, syncOne, status, setAuto, tick, pull, push, load };
}

module.exports = { createDongBo, pipeProcs, NAMES, EXCLUDES, safeName };
