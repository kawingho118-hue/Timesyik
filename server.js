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
      disabledMinions: {}, // 第3回合：記錄各玩家被封印的手下 { socketId: minionPower }
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

  // 3. 玩家選擇角色並加入房間 (修正角色 ID 對應牢房號碼)
  socket.on('joinRoom', ({ roomId, characterId, playerName, characterAvatar }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMessage', '找不到該房間 Code！');
    if (room.isGameOver) return socket.emit('errorMessage', '該房間的遊戲已經結束！');

    // 檢查角色是否已被選擇
    if (room.takenCharacters.includes(characterId)) {
      return socket.emit('errorMessage', '該角色已被其他玩家選擇，請選擇其他角色！');
    }

    // 🔒 建立角色 ID 到牢房號碼的對應對照表
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

    // 取得對應的牢房號碼（支援用 ID 或名字對應）
    const cellNo = CHARACTER_ID_CELL_MAP[characterId] || CHARACTER_CELL_MAP[playerName];

    if (!cellNo) {
      return socket.emit('errorMessage', '無效的角色，找不到對應的牢房號碼！');
    }

    const player = {
      id: socket.id,
      characterId,
      name: playerName,
      avatar: characterAvatar,
      cellNo: cellNo, // 角色專屬固定號碼
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

    // 🎯 牢房總數改為「當前玩家人數」（例：6人即為 1~6 號牢房）
    const totalCells = room.players.length;

    // 隨機產生本回合 200 分 Bonus 牢房 (範圍：1~人數)
    const bonusCell = Math.floor(Math.random() * totalCells) + 1;
    room.currentBonusCell = bonusCell;

        // 維護每間有效牢房基礎分數

    for (let i = 1; i <= totalCells; i++) {
      if (!room.cellAccumulatedScores[i])
         {room.cellAccumulatedScores[i] = 100;}
   }

    // 隨機產生本回合 200 分 Bonus 牢房 (範圍：1~人數)
    const bonusCell = Math.floor(Math.random() * totalCells) + 1;
    room.currentBonusCell = bonusCell;

      const addedBase = (i === room.currentBonusCell) ? 200 : 100;
      room.cellAccumulatedScores[i] += addedBase;
    }

    // 事件設定
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

    // 廣播回合開始及事件
    io.to(roomId).emit('roundStarted', {
      round: room.round,
      maxRounds: room.maxRounds,
      totalCells,
      eventInfo
    });

    // 個別通知玩家（第 3 回合帶有被禁用的手下資訊）
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

  // 6. 執行回合結算
  socket.on('triggerCalculateResults', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const totalCells = room.players.length;
    const summary = {};
    const tiesToResolve = [];

    // 計算當前各牢房爭奪總分（此時 cellAccumulatedScores 已經包含了上一回合累積 + 本回合新增的 100/200 分）
    const actualCellPoints = {};
    for (let i = 1; i <= totalCells; i++) {
      actualCellPoints[i] = room.cellAccumulatedScores[i] || 0;
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

    // 【第 2 回合特殊邏輯】找出搶奪者（非屋主）總戰力最高的牢房，該牢房糧食翻倍
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

    // 初始化 Summary 結構
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

      // 紀錄該牢房的所有出兵詳情
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

      // 情況 A：無人爭奪 / 無人防守（分數繼續累積到下一回合）
      if (ownerPower === 0 && totalInvaderPower === 0) {
        // 維持當前累積分數到下一回合
        room.cellAccumulatedScores[cellNo] = currentPoints;
        continue;
      }

      if (owner) {
        // 情況 B：無入侵者，屋主獨守 -> 獨得當前牢房所有累積糧食，隨後該牢房歸零
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

        // 情況 C：1 名入侵者
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

        // 情況 D：多名入侵者
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
        // 無屋主牢房
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
      winner.totalScore += points;
      room.cellAccumulatedScores[cellNo] = 0; // 平手裁決後該牢房糧食清空

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