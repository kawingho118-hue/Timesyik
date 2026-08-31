const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const MAX_ROUNDS = 4;

// 🔒 1. 角色與牢房號碼固定鎖定映射表
const CHARACTER_CELL_MAP = {
  '拉不拉卡': 1,
  '孫旺財': 2,
  '唐三角': 3,
  '雲蘇': 4,
  '王元鵝': 5,
  '諸葛帥坤': 6,
  '小程': 7,
  '李小白': 8
};

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
  console.log(`[DEBUG] 新 socket 連接！socketId=${socket.id}`);
  socket.on('disconnect', (reason) => {
    console.log(`[DEBUG] ⚠️ socket 斷開連接！socketId=${socket.id} 原因=${reason}`);
  });

  // 1. 主持人建立房間
  socket.on('createRoom', () => {
    let roomId = generateRoomCode();
    while (rooms[roomId]) {
      roomId = generateRoomCode();
    }

    rooms[roomId] = {
      roomId,
      hostSocketId: socket.id,
      round: 0,
      maxRounds: MAX_ROUNDS,
      players: [],
      takenCharacters: [],
      dispatches: {},
      cellAccumulatedScores: {},
      currentBonusCell: null,
      disabledMinions: {},
      isGameOver: false
    };

    socket.join(roomId);
    socket.emit('roomCreated', { roomId, maxRounds: MAX_ROUNDS });
    console.log(`[DEBUG] 房間已建立 roomId=${roomId} hostSocketId=${socket.id}`);
  });

  socket.on('checkTakenCharacters', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.emit('updateTakenCharacters', room.takenCharacters);
    } else {
      socket.emit('updateTakenCharacters', []);
    }
  });

  socket.on('joinRoom', ({ roomId, characterId, playerName, characterAvatar }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMessage', '找不到該房間 Code！');
    if (room.isGameOver) return socket.emit('errorMessage', '該房間的遊戲已經結束！');

    if (room.takenCharacters.includes(characterId)) {
      return socket.emit('errorMessage', '該角色已被其他玩家選擇，請選擇其他角色！');
    }

    const CHARACTER_ID_CELL_MAP = {
      1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8
    };

    const cellNo = CHARACTER_ID_CELL_MAP[characterId] || CHARACTER_CELL_MAP[playerName];

    if (!cellNo) {
      return socket.emit('errorMessage', '無效的角色，找不到對應的牢房號碼！');
    }

    const player = {
      id: socket.id,
      characterId,
      name: playerName,
      avatar: characterAvatar,
      cellNo: cellNo,
      totalScore: 0
    };

    room.players.push(player);
    room.takenCharacters.push(characterId);

    socket.join(roomId);
    socket.emit('joinSuccess', {
      roomId,
      playerName,
      characterAvatar,
      cellNo: player.cellNo,
      maxRounds: room.maxRounds
    });

    io.to(roomId).emit('updatePlayers', room.players);
    io.to(roomId).emit('updateTakenCharacters', room.takenCharacters);
    console.log(`[DEBUG] 玩家加入成功 roomId=${roomId} playerName=${playerName} socketId=${socket.id} 現時玩家數=${room.players.length}`);
  });

  socket.on('startNextRound', ({ roomId }) => {
    console.log(`[DEBUG] 收到 startNextRound request！roomId=${roomId} 發出者socketId=${socket.id}`);
    const room = rooms[roomId];
    if (!room) {
      console.log(`[DEBUG] ⚠️ 搵唔到 room！roomId=${roomId}`);
      return;
    }
    if (room.players.length === 0) {
      console.log(`[DEBUG] ⚠️ room 入面冇玩家！roomId=${roomId}`);
      return;
    }
    console.log(`[DEBUG] 準備開始回合，目前 room.round=${room.round}，room.players.length=${room.players.length}，房間內sockets=${JSON.stringify(Array.from(io.sockets.adapter.rooms.get(roomId) || []))}`);

    if (room.round >= room.maxRounds) {
      room.isGameOver = true;
      const leaderboard = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
      io.to(roomId).emit('gameOver', {
        message: `遊戲結束！已完成所有 ${room.maxRounds} 回合。`,
        leaderboard
      });
      console.log(`[DEBUG] 遊戲已結束 roomId=${roomId}`);
      return;
    }

    room.round += 1;
    console.log(`[DEBUG] room.round 已增加至 ${room.round}`);
    room.dispatches = {};
    room.disabledMinions = {};

    const totalCells = room.players.length;

    const bonusCell = Math.floor(Math.random() * totalCells) + 1;
    room.currentBonusCell = bonusCell;

    for (let i = 1; i <= totalCells; i++) {
      if (room.cellAccumulatedScores[i] === undefined) {
        room.cellAccumulatedScores[i] = 0;
      }
      const addedBase = (i === room.currentBonusCell) ? 200 : 100;
      room.cellAccumulatedScores[i] += addedBase;
    }

    let eventInfo = { round: room.round, description: '' };
    if (room.round === 1) {
      eventInfo.description = '無特殊事件，常規爭奪！';
    } else if (room.round === 2) {
      eventInfo.description = '🔥 雙倍食糧事件：本回合中，搶奪者總和戰力最高的牢房糧食分數翻倍（x2）！';
    } else if (room.round === 3) {
      eventInfo.description = '🚫 兵力受阻事件：本回合中，每位玩家隨機有 1 位手下無法出戰！';
      room.players.forEach(p => {
        room.disabledMinions[p.id] = Math.floor(Math.random() * 4) + 1;
      });
    } else if (room.round === 4) {
      eventInfo.description = '🤡 逆向搶奪事件：本回合搶奪者改由「戰力最低者」獨得糧食（戰力至少為 1）。防守方規則不受影響！';
    }

    console.log(`[DEBUG] 準備 emit roundStarted！round=${room.round} totalCells=${totalCells} roomId=${roomId}`);
    io.to(roomId).emit('roundStarted', {
      round: room.round,
      maxRounds: room.maxRounds,
      totalCells,
      eventInfo
    });
    console.log(`[DEBUG] 已 emit roundStarted 完成`);

    room.players.forEach(p => {
      const disabledMinion = room.disabledMinions[p.id] || null;
      io.to(p.id).emit('playerRoundConfig', { disabledMinion });
      console.log(`[DEBUG] 已 emit playerRoundConfig 俾 player socketId=${p.id} disabledMinion=${disabledMinion}`);
    });

    io.to(room.hostSocketId).emit('hostBonusNotice', {
      bonusCell,
      submittedCount: 0,
      totalPlayers: room.players.length
    });
    console.log(`[DEBUG] 已 emit hostBonusNotice 俾主持人`);
  });

  socket.on('submitMinions', ({ roomId, dispatchMap }) => {
    const room = rooms[roomId];
    if (!room || room.isGameOver) return;

    room.dispatches[socket.id] = dispatchMap;
    const submittedCount = Object.keys(room.dispatches).length;
    const totalPlayers = room.players.length;

    io.to(room.hostSocketId).emit('playerSubmittedNotice', {
      playerId: socket.id,
      submittedCount,
      totalPlayers
    });
  });

  socket.on('triggerCalculateResults', ({ roomId }) => {
    console.log(`[DEBUG] 收到 triggerCalculateResults request！roomId=${roomId} 現時room.round=${rooms[roomId] ? rooms[roomId].round : '房間不存在'}`);
    const room = rooms[roomId];
    if (!room) return;

    const totalCells = room.players.length;
    const summary = {};
    const tiesToResolve = [];

    const actualCellPoints = {};
    for (let i = 1; i <= totalCells; i++) {
      actualCellPoints[i] = room.cellAccumulatedScores[i] || 0;
    }

    const cellPowerMap = {};
    for (let c = 1; c <= totalCells; c++) cellPowerMap[c] = {};

    Object.entries(room.dispatches).forEach(([pId, dispatchMap]) => {
      Object.entries(dispatchMap).forEach(([minionPowerStr, targetCellNo]) => {
        const minionPower = parseInt(minionPowerStr);
        const cellNo = parseInt(targetCellNo);

        if (room.round === 3 && room.disabledMinions[pId] === minionPower) {
          return;
        }

        if (cellPowerMap[cellNo]) {
          if (!cellPowerMap[cellNo][pId]) cellPowerMap[cellNo][pId] = 0;
          cellPowerMap[cellNo][pId] += minionPower;
        }
      });
    });

    let doubleBonusCellNo = null;
    if (room.round === 2) {
      let maxTotalInvaderPower = 0;
      for (let c = 1; c <= totalCells; c++) {
        const owner = room.players.find(p => p.cellNo === c);
        const invaderEntries = Object.entries(cellPowerMap[c]).filter(([pId]) => !owner || pId !== owner.id);
        const invaderPowerSum = invaderEntries.reduce((sum, [_, pPower]) => sum + pPower, 0);

        if (invaderPowerSum > maxTotalInvaderPower) {
          maxTotalInvaderPower = invaderPowerSum;
          doubleBonusCellNo = c;
        }
      }
      if (doubleBonusCellNo && maxTotalInvaderPower > 0) {
        actualCellPoints[doubleBonusCellNo] *= 2;
      } else {
        doubleBonusCellNo = null;
      }
    }

    for (let i = 1; i <= totalCells; i++) {
      summary[i] = {
        points: actualCellPoints[i],
        isDouble: i === doubleBonusCellNo,
        status: 'NONE',
        winnerName: '',
        power: 0,
        details: []
      };
    }

    for (let cellNo = 1; cellNo <= totalCells; cellNo++) {
      const powers = cellPowerMap[cellNo];
      const owner = room.players.find(p => p.cellNo === cellNo);
      const ownerPower = owner && powers[owner.id] ? powers[owner.id] : 0;
      const currentPoints = actualCellPoints[cellNo];

      Object.entries(powers).forEach(([pId, pPower]) => {
        const pObj = room.players.find(p => p.id === pId);
        if (pObj && pPower > 0) {
          summary[cellNo].details.push({
            playerName: pObj.name,
            cellNo: cellNo,
            fromCellNo: pObj.cellNo,
            power: pPower
          });
        }
      });

      const invaderEntries = Object.entries(powers).filter(([pId, pPower]) => (!owner || pId !== owner.id) && pPower > 0);
      const totalInvaderPower = invaderEntries.reduce((sum, [_, pPower]) => sum + pPower, 0);

      if (ownerPower === 0 && totalInvaderPower === 0) {
        room.cellAccumulatedScores[cellNo] = currentPoints;
        continue;
      }

      if (owner) {
        if (invaderEntries.length === 0) {
          if (ownerPower > 0) {
            owner.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (獨守成功 +${currentPoints}分)`;
            summary[cellNo].power = ownerPower;
          } else {
            summary[cellNo].status = 'NONE';
          }
          room.cellAccumulatedScores[cellNo] = 0;
          continue;
        }

        if (invaderEntries.length === 1) {
          const [invaderId, invaderPower] = invaderEntries[0];
          const invader = room.players.find(p => p.id === invaderId);

          if (ownerPower > invaderPower) {
            owner.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (防守成功 +${currentPoints}分)`;
            summary[cellNo].power = ownerPower;
            room.cellAccumulatedScores[cellNo] = 0;
          } else if (invaderPower > ownerPower) {
            invader.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = invader.name;
            summary[cellNo].power = invaderPower;
            room.cellAccumulatedScores[cellNo] = 0;
          } else {
            summary[cellNo].status = 'TIE';
            summary[cellNo].power = ownerPower;
            tiesToResolve.push({
              cellNo,
              points: currentPoints,
              tiedPlayers: [owner, invader]
            });
          }
          continue;
        }

        if (invaderEntries.length > 1) {
          if (ownerPower >= totalInvaderPower) {
            owner.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (擊退所有搶奪者 +${currentPoints}分)`;
            summary[cellNo].power = ownerPower;
            room.cellAccumulatedScores[cellNo] = 0;
          } else {
            let targetInvaders = [];
            let targetPower = 0;

            if (room.round === 4) {
              let minPower = Infinity;
              invaderEntries.forEach(([_, pPower]) => {
                if (pPower < minPower) minPower = pPower;
              });
              targetPower = minPower;
              targetInvaders = invaderEntries
                .filter(([_, pPower]) => pPower === minPower)
                .map(([pId]) => room.players.find(p => p.id === pId));
            } else {
              let maxPower = 0;
              invaderEntries.forEach(([_, pPower]) => {
                if (pPower > maxPower) maxPower = pPower;
              });
              targetPower = maxPower;
              targetInvaders = invaderEntries
                .filter(([_, pPower]) => pPower === maxPower)
                .map(([pId]) => room.players.find(p => p.id === pId));
            }

            if (targetInvaders.length === 1) {
              const winner = targetInvaders[0];
              winner.totalScore += currentPoints;
              summary[cellNo].status = 'WIN';
              summary[cellNo].winnerName = winner.name + (room.round === 4 ? ' (逆向最低戰力勝出)' : '');
              summary[cellNo].power = targetPower;
              room.cellAccumulatedScores[cellNo] = 0;
            } else {
              summary[cellNo].status = 'TIE';
              summary[cellNo].power = targetPower;
              tiesToResolve.push({
                cellNo,
                points: currentPoints,
                tiedPlayers: targetInvaders
              });
            }
          }
          continue;
        }
      } else {
        let targetPlayers = [];
        let targetPower = 0;

        if (room.round === 4) {
          let minPower = Infinity;
          invaderEntries.forEach(([_, pPower]) => {
            if (pPower < minPower) minPower = pPower;
          });
          targetPower = minPower;
          targetPlayers = invaderEntries
            .filter(([_, pPower]) => pPower === minPower)
            .map(([pId]) => room.players.find(p => p.id === pId));
        } else {
          let maxPower = 0;
          invaderEntries.forEach(([_, pPower]) => {
            if (pPower > maxPower) maxPower = pPower;
          });
          targetPower = maxPower;
          targetPlayers = invaderEntries
            .filter(([_, pPower]) => pPower === maxPower)
            .map(([pId]) => room.players.find(p => p.id === pId));
        }

        if (targetPlayers.length === 1) {
          const winner = targetPlayers[0];
          winner.totalScore += currentPoints;
          summary[cellNo].status = 'WIN';
          summary[cellNo].winnerName = winner.name + (room.round === 4 ? ' (逆向最低戰力勝出)' : '');
          summary[cellNo].power = targetPower;
          room.cellAccumulatedScores[cellNo] = 0;
        } else if (targetPlayers.length > 1) {
          summary[cellNo].status = 'TIE';
          summary[cellNo].power = targetPower;
          tiesToResolve.push({
            cellNo,
            points: currentPoints,
            tiedPlayers: targetPlayers
          });
        }
      }
    }

    const isLastRound = room.round >= room.maxRounds;

    console.log(`[DEBUG] 準備 emit roundRevealed！round=${room.round} isLastRound=${isLastRound}`);
    io.to(roomId).emit('roundRevealed', {
      round: room.round,
      maxRounds: room.maxRounds,
      isLastRound,
      bonusCell: room.currentBonusCell,
      totalCells,
      summary,
      players: room.players,
      tiesToResolve
    });

    if (isLastRound) {
      room.isGameOver = true;
      const leaderboard = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
      io.to(roomId).emit('gameOver', {
        message: `遊戲結束！已完成所有 ${room.maxRounds} 回合。`,
        leaderboard
      });
    }
  });

  socket.on('resolveTie', ({ roomId, cellNo, winnerPlayerId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const winner = room.players.find(p => p.id === winnerPlayerId);
    if (winner) {
      let points = room.cellAccumulatedScores[cellNo] || 0;
      winner.totalScore += points;
      room.cellAccumulatedScores[cellNo] = 0;

      io.to(roomId).emit('tieResolved', {
        cellNo,
        winnerName: winner.name,
        players: room.players
      });
    }
  });

  socket.on('publishUpdatedScores', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('updatePlayers', room.players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});