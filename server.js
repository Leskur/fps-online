const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 地图: CS 十字形 (服务端权威碰撞检测用)
// 格子大小 4 世界单位, 地图 21x21
// ============================================================
const MAP_CELL = 4;
const W = 21, H = 21;
// 0=通道 1=墙
const MAP = (() => {
  const m = [];
  for (let r = 0; r < H; r++) {
    m.push(new Array(W).fill(1));
  }
  // 横向走廊 (中间行)
  const midR = Math.floor(H / 2);
  for (let c = 1; c < W - 1; c++) m[midR][c] = 0;
  // 纵向走廊 (中间列)
  const midC = Math.floor(W / 2);
  for (let r = 1; r < H - 1; r++) m[r][midC] = 0;
  // 四个区域各开一个小房间 (3x3)
  const rooms = [
    [2, 2], [2, W - 5], [H - 5, 2], [H - 5, W - 5],
  ];
  for (const [rr, cc] of rooms) {
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++)
        m[rr + dr][cc + dc] = 0;
  }
  // 连接走廊 -> 房间 (打通门洞)
  // 上半区左房间 -> 横向走廊
  for (let r = 3; r <= midR; r++) m[r][3] = 0;
  // 上半区右房间 -> 横向走廊
  for (let r = 3; r <= midR; r++) m[r][W - 4] = 0;
  // 下半区左房间 -> 横向走廊
  for (let r = midR; r <= H - 4; r++) m[r][3] = 0;
  // 下半区右房间 -> 横向走廊
  for (let r = midR; r <= H - 4; r++) m[r][W - 4] = 0;
  // 掩体 (横向走廊中间偏左右各一个)
  m[midR - 1][5] = 1; m[midR + 1][5] = 1;
  m[midR - 1][W - 6] = 1; m[midR + 1][W - 6] = 1;
  // 纵向走廊掩体
  m[5][midC - 1] = 1; m[5][midC + 1] = 1;
  m[H - 6][midC - 1] = 1; m[H - 6][midC + 1] = 1;
  return m;
})();

// 重生点列表 (格子坐标 -> 世界坐标)
const SPAWNS = [
  [2, 2], [2, W - 3], [H - 3, 2], [H - 3, W - 3],
  [Math.floor(H / 2), 2], [Math.floor(H / 2), W - 3],
  [2, Math.floor(W / 2)], [H - 3, Math.floor(W / 2)],
].map(([r, c]) => ({
  x: c * MAP_CELL + MAP_CELL / 2,
  z: r * MAP_CELL + MAP_CELL / 2,
}));

function randomSpawn() {
  return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

// ============================================================
// 玩家状态
// ============================================================
const players = {}; // socket.id -> playerState

function createPlayer(id, name) {
  const spawn = randomSpawn();
  return {
    id,
    name: name.substring(0, 16),
    x: spawn.x,
    y: 1.7,
    z: spawn.z,
    yaw: 0,
    pitch: 0,
    hp: 100,
    kills: 0,
    deaths: 0,
    alive: true,
    respawnAt: 0,
    lastUpdate: Date.now(),
  };
}

// ============================================================
// 射击服务端验证 (简单距离 + 射线近似)
// ============================================================
const BULLET_RANGE = 80;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;

// ============================================================
// 伤害处理 (抽出公共函数，射击/手雷共用)
// ============================================================
function applyDamage(shooter, victim, dmg) {
  victim.hp -= dmg;
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    shooter.kills++;
    victim.respawnAt = Date.now() + 3000;

    io.emit('playerDied', {
      victimId: victim.id,
      killerId: shooter.id,
      killerName: shooter.name,
      victimName: victim.name,
      kills: shooter.kills,
      deaths: victim.deaths,
    });

    setTimeout(() => {
      if (!players[victim.id]) return;
      const spawn = randomSpawn();
      victim.hp = 100;
      victim.alive = true;
      victim.x = spawn.x;
      victim.z = spawn.z;
      io.emit('playerRespawned', {
        id: victim.id,
        x: victim.x, y: 1.7, z: victim.z,
        hp: 100,
      });
    }, 3000);
  } else {
    io.to(victim.id).emit('youHurt', { hp: victim.hp, byId: shooter.id });
    io.to(shooter.id).emit('hitConfirm', { victimId: victim.id, hp: victim.hp });
  }
}

function raycastPlayers(shooter, dirX, dirY, dirZ) {
  // 从射手位置沿方向 cast，检测所有活着的其他玩家
  let best = null, bestDist = BULLET_RANGE;
  for (const pid in players) {
    if (pid === shooter.id) continue;
    const p = players[pid];
    if (!p.alive) continue;
    // 简化胶囊体碰撞: 对 y 区间 [0, PLAYER_HEIGHT] 检测圆柱
    // 计算射线与圆柱轴的最近点
    const ox = shooter.x - p.x;
    const oz = shooter.z - p.z;
    const a = dirX * dirX + dirZ * dirZ;
    const b = 2 * (ox * dirX + oz * dirZ);
    const c = ox * ox + oz * oz - PLAYER_RADIUS * PLAYER_RADIUS;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > bestDist) continue;
    // y 检测
    const hitY = shooter.y + dirY * t;
    if (hitY < 0 || hitY > PLAYER_HEIGHT) continue;
    best = p;
    bestDist = t;
  }
  return best ? { player: best, dist: bestDist } : null;
}

// ============================================================
// Socket.io 事件
// ============================================================
io.on('connection', (socket) => {
  console.log('连接:', socket.id);

  // 加入游戏
  socket.on('join', (data) => {
    const name = (data && data.name) ? String(data.name).trim() || '匿名' : '匿名';
    const p = createPlayer(socket.id, name);
    players[socket.id] = p;

    // 告知自己当前所有玩家 + 地图
    socket.emit('init', {
      self: socket.id,
      players: Object.values(players),
      map: MAP,
      mapCell: MAP_CELL,
    });

    // 告知其他人有新玩家
    socket.broadcast.emit('playerJoined', p);

    console.log(`${name} 加入, 当前 ${Object.keys(players).length} 人`);
  });

  // 玩家移动/视角同步 (高频, 不做服务端完整物理, 只转发)
  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.x = data.x; p.y = data.y; p.z = data.z;
    p.yaw = data.yaw; p.pitch = data.pitch;
    p.lastUpdate = Date.now();
    // 转发给其他人
    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
    });
  });

  // 射击 / 近战
  socket.on('shoot', (data) => {
    const shooter = players[socket.id];
    if (!shooter || !shooter.alive) return;

    const len = Math.sqrt(data.dx * data.dx + data.dy * data.dy + data.dz * data.dz);
    if (len < 0.001) return;
    const dx = data.dx / len, dy = data.dy / len, dz = data.dz / len;

    // 伤害依武器类型
    const dmgMap = { rifle: 25, pistol: 35, knife: 60 };
    const dmg = dmgMap[data.weapon] || 25;

    // 匕首近战：只检测近距离
    const maxRange = data.weapon === 'knife' ? 2.2 : BULLET_RANGE;

    const result = raycastPlayers(shooter, dx, dy, dz);
    const hitInRange = result && result.dist <= maxRange;

    // 通知所有人: 特效
    io.emit('shotFired', {
      shooterId: socket.id,
      weapon: data.weapon,
      ox: shooter.x, oy: shooter.y + 0.1, oz: shooter.z,
      dx, dy, dz,
      hit: hitInRange ? result.player.id : null,
    });

    if (hitInRange) {
      applyDamage(shooter, result.player, dmg);
    }
  });

  // 手雷爆炸 (客户端落点，服务端算范围伤害)
  socket.on('grenade', (data) => {
    const shooter = players[socket.id];
    if (!shooter || !shooter.alive) return;

    const NADE_RADIUS = 5.5;
    const NADE_DMG    = 80;

    // 通知所有客户端播放爆炸特效
    io.emit('grenadeExplode', { x: data.x, y: data.y, z: data.z, shooterId: socket.id });

    // 范围伤害
    for (const pid in players) {
      const p = players[pid];
      if (!p.alive) continue;
      const dx = p.x - data.x, dz = p.z - data.z, dy = p.y - data.y;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dist <= NADE_RADIUS) {
        // 距离衰减
        const dmg = Math.round(NADE_DMG * (1 - dist / NADE_RADIUS));
        if (dmg > 0) applyDamage(shooter, p, dmg);
      }
    }
  });

  // 断开
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`${p.name} 离开`);
      delete players[socket.id];
      io.emit('playerLeft', { id: socket.id });
    }
  });
});

// ============================================================
// 定期同步排行榜
// ============================================================
setInterval(() => {
  const scoreboard = Object.values(players)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, hp: p.hp, alive: p.alive }))
    .sort((a, b) => b.kills - a.kills);
  io.emit('scoreboard', scoreboard);
}, 2000);

// ============================================================
// 启动
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 FPS 服务器运行在 http://localhost:${PORT}`);
  console.log(`   公网部署: 将端口 ${PORT} 映射到外网即可`);
  console.log(`   或使用 frp/ngrok: ngrok http ${PORT}\n`);
});
