const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const MAX_ROUNDS = 4;

// 🔒 角色 ID 與牢房號碼固定映射表
const CHARACTER_ID_CELL_MAP = {
  1: 1, // 拉不拉卡
  2: 2, // 孫旺財
  3: 3, // 唐三角
  4: 4, // 雲蘇
  5: 5, // 王元鵝
  6: 6, // 諸葛帥坤
  7: 7, // 小程
  8: 8  // 李小白
};

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
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
      cellAccumulatedScores: {}, // 記錄各牢房當前累積的糧食分數
      currentBonusCell: null,
      disabledMinions: {}, 
      isGameOver: false
    };

    socket.join(roomId);
    socket.emit('roomCreated', { roomId, maxRounds: MAX_ROUNDS });
  });

  // 2. 查詢已被選走的角色
  socket.on('checkTakenCharacters', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.emit('updateTakenCharacters', room.takenCharacters);
    } else {
      socket.emit('updateTakenCharacters', []);
    }
  });

  // 3. 玩家選擇角色並加入房間
  socket.on('joinRoom', ({ roomId, characterId, playerName, characterAvatar }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMessage', '找不到該房間 Code！');
    if (room.isGameOver) return socket.emit('errorMessage', '該房間的遊戲已經結束！');

    if (room.takenCharacters.includes(characterId)) {
      return socket.emit('errorMessage', '該角色已被其他玩家選擇，請選擇其他角色！');
    }

    const cellNo = CHARACTER_ID_CELL_MAP[characterId];
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
  });

  // 4. 開始下一回合
  socket.on('startNextRound', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.players.length === 0) return;

    if (room.round >= room.maxRounds) {
      room.isGameOver = true;
      const leaderboard = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
      io.to(roomId).emit('gameOver', {
        message: `遊戲結束！已完成所有 ${room.maxRounds} 回合。`,
        leaderboard
      });
      return;
    }

    room.round += 1;
    room.dispatches = {};
    room.disabledMinions = {};

    const totalCells = room.players.length;

    // 每一回合開始時：各牢房注入 100 預設保底糧食
    for (let i = 1; i <= totalCells; i++) {
      if (room.cellAccumulatedScores[i] === undefined) {
        room.cellAccumulatedScores[i] = 100; // 第一回合初始 100
      } else {
        room.cellAccumulatedScores[i] += 100; // 後續回合加上 100 預設保底
      }
    }

    // 隨機產生本回合 200 分 Bonus 牢房
    const bonusCell = Math.floor(Math.random() * totalCells) + 1;
    room.currentBonusCell = bonusCell;

    let eventInfo = { round: room.round, description: '' };
    if (room.round === 1) {
      eventInfo.description = '第 1 回合：無特殊事件，常規爭奪！';
    } else if (room.round === 2) {
      eventInfo.description = '🔥 第 2 回合「雙倍食糧」：搶奪者總和戰力最高的牢房糧食分數翻倍（x2）！';
    } else if (room.round === 3) {
      eventInfo.description = '🚫 第 3 回合「兵力受阻」：每位玩家隨機有 1 位手下無法出戰！';
      room.players.forEach(p => {
        room.disabledMinions[p.id] = Math.floor(Math.random() * 4) + 1;
      });
    } else if (room.round === 4) {
      eventInfo.description = '🤡 第 4 回合「逆向搶奪」：搶奪者改由「戰力最低者」獨得糧食（戰力至少 1）。';
    }

    io.to(roomId).emit('roundStarted', {
      round: room.round,
      maxRounds: room.maxRounds,
      totalCells,
      eventInfo
    });

    room.players.forEach(p => {
      const disabledMinion = room.disabledMinions[p.id] || null;
      io.to(p.id).emit('playerRoundConfig', { disabledMinion });
    });

    io.to(room.hostSocketId).emit('hostBonusNotice', {
      bonusCell,
      submittedCount: 0,
      totalPlayers: room.players.length
    });
  });

  // 5. 玩家提交兵力分配
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

  // 6. 執行回合結算 (核心規則更新)
  socket.on('triggerCalculateResults', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const totalCells = room.players.length;
    const summary = {};
    const tiesToResolve = [];

    // 計算當前各牢房含 Bonus 的實際爭奪總分
    const actualCellPoints = {};
    for (let i = 1; i <= totalCells; i++) {
      let points = room.cellAccumulatedScores[i] || 0;
      if (i === room.currentBonusCell) points += 200;
      actualCellPoints[i] = points;
    }

    // 彙整各牢房對應玩家投入的總戰力
    const cellPowerMap = {};
    for (let c = 1; c <= totalCells; c++) cellPowerMap[c] = {};

    Object.entries(room.dispatches).forEach(([pId, dispatchMap]) => {
      Object.entries(dispatchMap).forEach(([minionPowerStr, targetCellNo]) => {
        const minionPower = parseInt(minionPowerStr);
        const cellNo = parseInt(targetCellNo);

        // 第 3 回合防呆：若該手下被封印，戰力不計算
        if (room.round === 3 && room.disabledMinions[pId] === minionPower) {
          return;
        }

        if (cellPowerMap[cellNo]) {
          if (!cellPowerMap[cellNo][pId]) cellPowerMap[cellNo][pId] = 0;
          cellPowerMap[cellNo][pId] += minionPower;
        }
      });
    });

    // 【第 2 回合特殊邏輯】雙倍糧食
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

      // ----------------------------------------------------
      // 結算判定（套用全新規則：無人防守/獨守 = 屋主全取；攻破 = 歸零）
      // ----------------------------------------------------

      // 情況 A：無人爭奪 / 無人防守（完全沒人派兵）
      if (ownerPower === 0 && totalInvaderPower === 0) {
        if (owner) {
          owner.totalScore += currentPoints; // 房主全取當前牢房糧食
        }
        room.cellAccumulatedScores[cellNo] = 0; // 結算後歸零，等待下回合注入 100 預設
        summary[cellNo].status = 'WIN';
        summary[cellNo].winnerName = owner ? `${owner.name} (無人爭奪，全取 +${currentPoints}分)` : '無人';
        continue;
      }

      if (owner) {
        // 情況 B：無入侵者，但屋主有派人守
        if (invaderEntries.length === 0) {
          if (ownerPower > 0) {
            owner.totalScore += currentPoints; // 房主全取
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (屋主獨守成功，全取 +${currentPoints}分)`;
          }
          room.cellAccumulatedScores[cellNo] = 0; // 歸零
          continue;
        }

        // 情況 C：1 名入侵者
        if (invaderEntries.length === 1) {
          const [invaderId, invaderPower] = invaderEntries[0];
          const invader = room.players.find(p => p.id === invaderId);

          if (ownerPower > invaderPower) {
            // 屋主防守成功
            owner.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (防守成功，全取 +${currentPoints}分)`;
            room.cellAccumulatedScores[cellNo] = 0; // 歸零
          } else if (invaderPower > ownerPower) {
            // 入侵者攻破
            invader.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = invader.name + ' (成功攻破牢房！)';
            summary[cellNo].power = invaderPower;
            room.cellAccumulatedScores[cellNo] = 0; // 攻破後牢房糧食歸零
          } else {
            // 平手
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

        // 情況 D：多名入侵者
        if (invaderEntries.length > 1) {
          if (ownerPower >= totalInvaderPower) {
            // 屋主擊退所有入侵者
            owner.totalScore += currentPoints;
            summary[cellNo].status = 'WIN';
            summary[cellNo].winnerName = `${owner.name} (擊退所有搶奪者，全取 +${currentPoints}分)`;
            room.cellAccumulatedScores[cellNo] = 0; // 歸零
          } else {
            let targetInvaders = [];
            let targetPower = 0;

            if (room.round === 4) {
              let minPower = Infinity;
              invaderEntries.forEach(([_, pPower]) => { if (pPower < minPower) minPower = pPower; });
              targetPower = minPower;
              targetInvaders = invaderEntries.filter(([_, pPower]) => pPower === minPower).map(([pId]) => room.players.find(p => p.id === pId));
            } else {
              let maxPower = 0;
              invaderEntries.forEach(([_, pPower]) => { if (pPower > maxPower) maxPower = pPower; });
              targetPower = maxPower;
              targetInvaders = invaderEntries.filter(([_, pPower]) => pPower === maxPower).map(([pId]) => room.players.find(p => p.id === pId));
            }

            if (targetInvaders.length === 1) {
              const winner = targetInvaders[0];
              winner.totalScore += currentPoints;
              summary[cellNo].status = 'WIN';
              summary[cellNo].winnerName = winner.name + (room.round === 4 ? ' (逆向最低戰力勝出)' : ' (成功攻破牢房！)');
              summary[cellNo].power = targetPower;
              room.cellAccumulatedScores[cellNo] = 0; // 攻破歸零
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
        // 無屋主牢房
        let targetPlayers = [];
        let targetPower = 0;

        if (room.round === 4) {
          let minPower = Infinity;
          invaderEntries.forEach(([_, pPower]) => { if (pPower < minPower) minPower = pPower; });
          targetPower = minPower;
          targetPlayers = invaderEntries.filter(([_, pPower]) => pPower === minPower).map(([pId]) => room.players.find(p => p.id === pId));
        } else {
          let maxPower = 0;
          invaderEntries.forEach(([_, pPower]) => { if (pPower > maxPower) maxPower = pPower; });
          targetPower = maxPower;
          targetPlayers = invaderEntries.filter(([_, pPower]) => pPower === maxPower).map(([pId]) => room.players.find(p => p.id === pId));
        }

        if (targetPlayers.length === 1) {
          const winner = targetPlayers[0];
          winner.totalScore += currentPoints;
          summary[cellNo].status = 'WIN';
          summary[cellNo].winnerName = winner.name + (room.round === 4 ? ' (逆向最低戰力勝出)' : '');
          summary[cellNo].power = targetPower;
          room.cellAccumulatedScores[cellNo] = 0; // 歸零
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
  });

  // 7. 手動裁決平手
  socket.on('resolveTie', ({ roomId, cellNo, winnerPlayerId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const winner = room.players.find(p => p.id === winnerPlayerId);
    if (winner) {
      let points = room.cellAccumulatedScores[cellNo] || 0;
      if (cellNo === room.currentBonusCell) points += 200;

      winner.totalScore += points;
      room.cellAccumulatedScores[cellNo] = 0; // 平手裁決後該牢房糧食歸零

      io.to(roomId).emit('tieResolved', {
        cellNo,
        winnerName: winner.name,
        players: room.players
      });
    }
  });

  // 8. 廣播最新分數
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