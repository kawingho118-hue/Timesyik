const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// 房間保留在記憶體：關閉網頁不會刪除房間；重新啟動伺服器則會清空。
const rooms = new Map();
const MAX_ROUNDS = 4;
const HOST_PASSWORD = process.env.HOST_PASSWORD || '0118';
const CHARACTERS = [
  { id: 1, name: '拉不拉卡', avatar: '/拉不拉卡.jpeg' },
  { id: 2, name: '孫旺財', avatar: '/孫旺財.jpeg' },
  { id: 3, name: '唐三角', avatar: '/唐三角.jpeg' },
  { id: 4, name: '雲蘇', avatar: '/云蘇.jpeg' },
  { id: 5, name: '王元鵝', avatar: '/王元鵝.jpeg' },
  { id: 6, name: '諸葛帥坤', avatar: '/諸葛帥坤.jpeg' },
  { id: 7, name: '小程', avatar: '/小程.jpeg' },
  { id: 8, name: '李小白', avatar: '/李小白.jpeg' }
];
const token = () => crypto.randomBytes(32).toString('hex');
const publicPlayers = room => room.players.map(p => ({
  id: p.id, characterId: p.characterId, name: p.name, avatar: p.avatar,
  cellNo: p.cellNo, totalScore: p.totalScore, connected: Boolean(p.socketId)
}));
const cellsOf = room => room.players.map(p => p.cellNo).sort((a, b) => a - b);

function sendState(room) {
  const common = {
    roomId: room.roomId, phase: room.phase, round: room.round,
    maxRounds: MAX_ROUNDS, players: publicPlayers(room), cells: cellsOf(room),
    eventInfo: room.eventInfo, submittedCount: Object.keys(room.dispatches).length,
    summary: room.summary, pendingTies: Object.keys(room.ties).length,
    // 隱藏獎勵位置只在結算後向玩家公開。
    bonusCell: room.phase === 'revealed' || room.phase === 'ended' ? room.bonusCell : null
  };
  if (room.hostSocketId) io.to(room.hostSocketId).emit('roomState', {
    ...common, role: 'host', bonusCell: room.bonusCell,
    tiesToResolve: Object.values(room.ties)
  });
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('roomState', {
      ...common, role: 'player', playerId: p.id,
      disabledMinion: room.disabledMinions[p.id] || null,
      submitted: Boolean(room.dispatches[p.id]),
      myDispatch: room.dispatches[p.id] || null
    });
  });
}

function bindSession(socket, room, role, player) {
  // 同一身份只由最新連線操作，並以固定 player.id 保存派兵及分數。
  const previousId = role === 'host' ? room.hostSocketId : player.socketId;
  if (previousId && previousId !== socket.id) {
    const previous = io.sockets.sockets.get(previousId);
    if (previous) {
      previous.data.session = null;
      previous.leave(room.roomId);
      previous.emit('sessionReplaced');
    }
  }
  socket.data.session = { roomId: room.roomId, role, playerId: player ? player.id : null };
  if (role === 'host') room.hostSocketId = socket.id;
  else player.socketId = socket.id;
  socket.join(room.roomId);
}

function sessionRoom(socket, roomId, hostOnly = false) {
  const session = socket.data.session;
  const room = session && rooms.get(session.roomId);
  if (!room || session.roomId !== roomId || (hostOnly && session.role !== 'host')) return null;
  if (session.role === 'host') return room.hostSocketId === socket.id ? room : null;
  const player = room.players.find(p => p.id === session.playerId);
  return player && player.socketId === socket.id ? room : null;
}

io.on('connection', socket => {
  function fail(ack, message, code = 'INVALID_ACTION') {
    if (typeof ack === 'function') ack({ ok: false, code, message });
    else socket.emit('errorMessage', message);
  }
  function done(ack, room, extra = {}) {
    if (typeof ack === 'function') ack({ ok: true, ...extra });
    sendState(room);
  }

  socket.on('createRoom', (data = {}, ack) => {
    if (data.password !== HOST_PASSWORD) return fail(ack, '密碼錯誤，請重新輸入！');
    // 回覆遺失後重試，不會重複建立房間。
    const existing = socket.data.session && rooms.get(socket.data.session.roomId);
    if (existing) {
      if (socket.data.session.role !== 'host') return fail(ack, '你已加入另一個房間。');
      return done(ack, existing, { session: { roomId: existing.roomId, role: 'host', token: existing.hostToken } });
    }
    if (rooms.size >= 9000) return fail(ack, '房間已滿，請稍後再試。');
    let roomId;
    do { roomId = String(crypto.randomInt(1000, 10000)); } while (rooms.has(roomId));
    const room = {
      roomId, hostToken: token(), hostSocketId: null, players: [],
      phase: 'lobby', round: 0, dispatches: {}, disabledMinions: {},
      bonusCell: null, eventInfo: '', summary: null, ties: {}
    };
    rooms.set(roomId, room);
    bindSession(socket, room, 'host');
    done(ack, room, { session: { roomId, role: 'host', token: room.hostToken } });
  });

  socket.on('checkTakenCharacters', (roomId, ack) => {
    const room = rooms.get(String(roomId));
    if (typeof ack === 'function') ack({
      roomId: String(roomId), takenIds: room ? room.players.map(p => p.characterId) : []
    });
  });

  socket.on('joinRoom', (data = {}, ack) => {
    const roomId = String(data.roomId || '');
    const room = rooms.get(roomId);
    if (!room) return fail(ack, '找不到該房間 Code！');
    const existingSession = socket.data.session;
    if (existingSession) {
      const p = room.players.find(p => p.id === existingSession.playerId);
      if (existingSession.roomId === roomId && existingSession.role === 'player' && p) {
        return done(ack, room, { session: { roomId, role: 'player', token: p.token } });
      }
      return fail(ack, '你已經登入另一個身份。');
    }
    if (room.phase !== 'lobby') return fail(ack, '遊戲已開始；原有玩家請使用原本瀏覽器恢復連線。');
    const character = CHARACTERS.find(c => c.id === Number(data.characterId));
    if (!character) return fail(ack, '請選擇有效角色。');
    if (room.players.some(p => p.characterId === character.id)) return fail(ack, '該角色已被其他玩家選擇！');
    const player = {
      id: crypto.randomUUID(), token: token(), socketId: null,
      characterId: character.id, name: character.name, avatar: character.avatar,
      cellNo: character.id, totalScore: 0
    };
    room.players.push(player);
    bindSession(socket, room, 'player', player);
    done(ack, room, { session: { roomId, role: 'player', token: player.token } });
  });

  socket.on('resumeSession', (data = {}, ack) => {
    const room = rooms.get(String(data.roomId || ''));
    if (!room) return fail(ack, '原本房間已不存在，伺服器可能已重新啟動。', 'SESSION_INVALID');
    const player = data.role === 'player' && room.players.find(p => p.token === data.token);
    if ((data.role === 'host' && room.hostToken === data.token) || player) {
      bindSession(socket, room, data.role, player || undefined);
      return done(ack, room);
    }
    fail(ack, '無法驗證原本身份，請重新登入。', 'SESSION_INVALID');
  });

  socket.on('syncState', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId);
    if (!room) return fail(ack, '請先恢復房間連線。', 'SESSION_REQUIRED');
    done(ack, room);
  });

  socket.on('startNextRound', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId, true);
    if (!room) return fail(ack, '只有已連線的主持人可以開始回合。');
    if (data.round !== room.round) return fail(ack, '回合已更新，請同步畫面後再操作。');
    if (!['lobby', 'revealed'].includes(room.phase) || room.round >= MAX_ROUNDS) return fail(ack, '目前不能開始下一回合。');
    if (Object.keys(room.ties).length) return fail(ack, '請先完成所有平手裁決。');
    if (!room.players.length) return fail(ack, '請先等待玩家加入。');
    room.round++;
    room.phase = 'dispatch';
    room.dispatches = {};
    room.disabledMinions = {};
    room.summary = null;
    room.ties = {};
    const cells = cellsOf(room);
    room.bonusCell = cells[crypto.randomInt(cells.length)];
    room.eventInfo = [
      '', '無特殊事件',
      '🔥 雙倍食糧事件：搶奪者總和戰力最高的牢房糧食分數翻倍（x2）！',
      '🚫 兵力受阻事件：每位玩家隨機有 1 位手下無法出戰！',
      '🤡 逆向搶奪事件：搶奪者改由「戰力最低者」獨得糧食（戰力至少為 1）。防守方規則不受影響！'
    ][room.round];
    if (room.round === 3) room.players.forEach(p => { room.disabledMinions[p.id] = crypto.randomInt(1, 5); });
    done(ack, room);
  });

  socket.on('submitMinions', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId);
    const session = socket.data.session;
    if (!room || session.role !== 'player') return fail(ack, '請先以玩家身份恢復連線。');
    if (room.phase !== 'dispatch' || data.round !== room.round) return fail(ack, '呢個回合已停止收集陣容。');
    const playerId = session.playerId;
    // 同一回合重試提交只回傳原有結果，不覆蓋已確認的陣容。
    if (room.dispatches[playerId]) return done(ack, room);
    const map = data.dispatchMap;
    const disabled = room.disabledMinions[playerId];
    const cells = cellsOf(room);
    const expected = [1, 2, 3, 4].filter(n => n !== disabled);
    if (!map || typeof map !== 'object' || Array.isArray(map) ||
        Object.keys(map).length !== expected.length ||
        expected.some(n => !Object.hasOwn(map, n) || !cells.includes(map[n]))) {
      return fail(ack, '陣容無效，請重新選擇。');
    }
    room.dispatches[playerId] = Object.fromEntries(expected.map(n => [n, map[n]]));
    done(ack, room);
  });

  socket.on('triggerCalculateResults', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId, true);
    if (!room) return fail(ack, '只有主持人可以結算。');
    if (data.round !== room.round) return fail(ack, '回合已更新，請先同步。');
    if (room.phase === 'revealed') return done(ack, room);
    if (room.phase !== 'dispatch') return fail(ack, '目前沒有可結算的回合。');
    const cells = cellsOf(room);
    const powerMap = Object.fromEntries(cells.map(c => [c, {}]));
    Object.entries(room.dispatches).forEach(([id, dispatch]) => {
      Object.entries(dispatch).forEach(([power, cell]) => {
        powerMap[cell][id] = (powerMap[cell][id] || 0) + Number(power);
      });
    });
    const invaderTotals = Object.fromEntries(cells.map(c => {
      const owner = room.players.find(p => p.cellNo === c);
      return [c, Object.entries(powerMap[c]).reduce((sum, [id, power]) => sum + (id === owner.id ? 0 : power), 0)];
    }));
    const maxInvaderPower = Math.max(...Object.values(invaderTotals));
    room.summary = {};
    room.ties = {};
    cells.forEach(c => {
      const owner = room.players.find(p => p.cellNo === c);
      const powers = powerMap[c];
      const ownerPower = powers[owner.id] || 0;
      const invaders = Object.entries(powers).filter(([id, power]) => id !== owner.id && power > 0);
      const totalInvaderPower = invaderTotals[c];
      const isDouble = room.round === 2 && maxInvaderPower > 0 && totalInvaderPower === maxInvaderPower;
      const points = (c === room.bonusCell ? 200 : 100) * (isDouble ? 2 : 1);
      const info = room.summary[c] = {
        points, isDouble, status: 'NONE', winnerName: '', winnerIsOwner: false, power: 0,
        details: Object.entries(powers).map(([id, power]) => {
          const p = room.players.find(p => p.id === id);
          return { playerName: p.name, fromCellNo: p.cellNo, power };
        })
      };
      if (ownerPower === 0 && totalInvaderPower === 0) return;
      let winners;
      if (ownerPower >= totalInvaderPower) {
        winners = [owner];
        info.power = ownerPower;
      } else {
        info.power = room.round === 4 ? Math.min(...invaders.map(([, p]) => p)) : Math.max(...invaders.map(([, p]) => p));
        winners = invaders.filter(([, p]) => p === info.power).map(([id]) => room.players.find(p => p.id === id));
      }
      if (winners.length === 1) {
        const winner = winners[0];
        winner.totalScore += points;
        Object.assign(info, { status: 'WIN', winnerName: winner.name, winnerIsOwner: winner.id === owner.id });
      } else {
        info.status = 'TIE';
        room.ties[c] = { cellNo: c, points, tiedPlayers: winners.map(p => ({ id: p.id, name: p.name })) };
      }
    });
    room.phase = 'revealed';
    done(ack, room);
  });

  socket.on('resolveTie', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId, true);
    if (!room) return fail(ack, '只有主持人可以裁決。');
    if (room.phase !== 'revealed' || data.round !== room.round) return fail(ack, '目前不能裁決。');
    const tie = room.ties[data.cellNo];
    // 重試已完成的裁決不會重複加分。
    if (!tie) return done(ack, room);
    if (!tie.tiedPlayers.some(p => p.id === data.winnerPlayerId)) return fail(ack, '請選擇該牢房的平手玩家。');
    const winner = room.players.find(p => p.id === data.winnerPlayerId);
    winner.totalScore += tie.points;
    Object.assign(room.summary[data.cellNo], {
      status: 'WIN', winnerName: winner.name, winnerIsOwner: winner.cellNo === Number(data.cellNo), resolved: true
    });
    delete room.ties[data.cellNo];
    done(ack, room);
  });

  socket.on('publishUpdatedScores', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId, true);
    if (!room) return fail(ack, '只有主持人可以發布分數。');
    done(ack, room);
  });

  socket.on('leaveFinishedGame', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId);
    if (!room || room.phase !== 'ended') return fail(ack, '請先完成遊戲。');
    const session = socket.data.session;
    if (session.role === 'host') room.hostSocketId = null;
    else room.players.find(p => p.id === session.playerId).socketId = null;
    socket.data.session = null;
    socket.leave(room.roomId);
    done(ack, room);
  });

  socket.on('endGame', (data = {}, ack) => {
    const room = sessionRoom(socket, data.roomId, true);
    if (!room) return fail(ack, '只有主持人可以結束遊戲。');
    if (room.phase === 'ended') return done(ack, room);
    if (room.round !== MAX_ROUNDS || room.phase !== 'revealed') return fail(ack, '尚未完成全部回合結算。');
    if (Object.keys(room.ties).length) return fail(ack, '請先完成平手裁決。');
    room.phase = 'ended';
    done(ack, room);
  });

  socket.on('disconnect', () => {
    const session = socket.data.session;
    const room = session && rooms.get(session.roomId);
    if (!room) return;
    if (session.role === 'host' && room.hostSocketId === socket.id) room.hostSocketId = null;
    const player = room.players.find(p => p.id === session.playerId);
    if (player && player.socketId === socket.id) player.socketId = null;
    // 保留身份、角色、陣容與分數，等待 Token 恢復。
    sendState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));