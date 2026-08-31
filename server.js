const socket = io();
let currentRoomId = '';
let myCellNo = 0;
let currentDisabledMinion = null;
let currentRound = 1;
let totalPlayersCount = 0;

const CHARACTERS = [
  { id: 1, name: '拉不拉卡', avatar: '/拉不拉卡.jpeg' },
  { id: 2, name: '孫旺財',   avatar: '/孫旺財.jpeg' },
  { id: 3, name: '雲蘇',     avatar: '/云蘇.jpeg' },
  { id: 4, name: '唐三角',   avatar: '/唐三角.jpeg' },
  { id: 5, name: '諸葛帥坤', avatar: '/諸葛帥坤.jpeg' },
  { id: 6, name: '王元鵝',   avatar: '/王元鵝.jpeg' },
  { id: 7, name: '小程',     avatar: '/小程.jpeg' },
  { id: 8, name: '李小白',   avatar: '/李小白.jpeg' }
];

let takenCharacterIds = [];

function showScreen(screenId) {
  const screens = ['home-screen', 'host-screen', 'player-setup-screen', 'player-game-screen'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === screenId) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
}

function showHostSetup() {
  showScreen('host-screen');
  socket.emit('createRoom');
}

function showPlayerSetup() {
  showScreen('player-setup-screen');
  renderCharacterSelect();
}

function renderCharacterSelect() {
  const select = document.getElementById('character-select');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '';

  CHARACTERS.forEach(char => {
    const isTaken = takenCharacterIds.includes(char.id);
    const option = document.createElement('option');
    option.value = char.id;
    option.textContent = isTaken ? `${char.name} (已被選擇)` : char.name;
    option.disabled = isTaken;
    select.appendChild(option);
  });

  if (currentValue && !takenCharacterIds.includes(parseInt(currentValue))) {
    select.value = currentValue;
  } else {
    const availableChar = CHARACTERS.find(c => !takenCharacterIds.includes(c.id));
    if (availableChar) select.value = availableChar.id;
  }

  updatePreview();
}

function onCharacterChange() {
  updatePreview();
}

function updatePreview() {
  const select = document.getElementById('character-select');
  const avatarImg = document.getElementById('preview-avatar');
  const nameText = document.getElementById('preview-name');
  if (!select) return;

  if (!select.value) {
    if (avatarImg) avatarImg.src = '';
    if (nameText) nameText.innerText = '無可用角色';
    return;
  }
  const charId = parseInt(select.value);
  const char = CHARACTERS.find(c => c.id === charId);

  if (char) {
    if (avatarImg) avatarImg.src = char.avatar;
    if (nameText) nameText.innerText = char.name;
  }
}

function onRoomCodeChange() {
  const codeInput = document.getElementById('room-code-input');
  if (!codeInput) return;
  const code = codeInput.value.trim();
  if (code.length === 4) {
    socket.emit('checkTakenCharacters', code);
  } else {
    takenCharacterIds = [];
    renderCharacterSelect();
  }
}

function joinRoom() {
  const codeInput = document.getElementById('room-code-input');
  const select = document.getElementById('character-select');
  if (!codeInput || !select) return;

  const code = codeInput.value.trim();
  const charId = parseInt(select.value);

  if (!code) return alert('請輸入 4 位數房間 Code！');
  if (!charId) return alert('請選擇一個角色！');
  if (takenCharacterIds.includes(charId)) return alert('該角色已被選擇，請選取其他角色！');

  const selectedChar = CHARACTERS.find(c => c.id === charId);

  socket.emit('joinRoom', {
    roomId: code,
    characterId: selectedChar.id,
    playerName: selectedChar.name,
    characterAvatar: selectedChar.avatar
  });
}

// 🛡️ 超強保險選單生成器：多重相容極限避錯
function initSelects(totalCells, disabledMinion = null) {
  currentDisabledMinion = disabledMinion;

  // 兜底算式：如果有傳 totalCells 用 totalCells，沒有就用現有人數，再沒有預設 8 個牢房
  let count = 8;
  if (typeof totalCells === 'number' && totalCells > 0) {
    count = totalCells;
  } else if (totalPlayersCount > 0) {
    count = totalPlayersCount;
  }

  [1, 2, 3, 4].forEach(num => {
    const select = document.getElementById(`m${num}`);
    const row = document.getElementById(`row-m${num}`);
    if (!select) return;

    select.innerHTML = '';

    if (disabledMinion === num) {
      if (row) row.classList.add('minion-disabled');
      select.disabled = true;
      select.innerHTML = `<option value="0">⛔ 該手下受阻無法出戰</option>`;
    } else {
      if (row) row.classList.remove('minion-disabled');
      select.disabled = false;
      for (let i = 1; i <= count; i++) {
        select.innerHTML += `<option value="${i}">前往 ${i} 號牢房</option>`;
      }
    }
  });
}

// 🔧 修改：以往呢度會一次過 emit 'startNextRound' 同 'startRound' 兩個event，
// 導致server可能收到兩個request，觸發兩次開波邏輯，令回合狀態錯亂，
// 令第二回合之後開始唔到。而家改為只send一個event。
// ⚠️ 如果之後發現server.js嗰邊監聽緊嘅係 'startRound' 而唔係 'startNextRound'，
// 只需要將下面呢個字串改返做 'startRound' 就得。
function startNextRound() {
  socket.emit('startNextRound', { roomId: currentRoomId });
}

// 🔧 同樣道理，呢度以往都係一次過 emit 兩個event ('triggerCalculateResults' 同 'calcRound')，
// 有同樣嘅雙重觸發風險，一併修正為只send一個。
// ⚠️ 如果server.js監聽緊嘅係 'calcRound'，將下面字串改返做 'calcRound' 即可。
function triggerCalculateResults() {
  socket.emit('triggerCalculateResults', { roomId: currentRoomId });
}

function publishUpdatedScores() {
  socket.emit('publishUpdatedScores', { roomId: currentRoomId });
}

function submitDispatch() {
  const dispatchMap = {};
  [1, 2, 3, 4].forEach(num => {
    if (currentDisabledMinion !== num) {
      const el = document.getElementById(`m${num}`);
      if (el) {
        const val = parseInt(el.value);
        if (val) dispatchMap[num] = val;
      }
    }
  });

  socket.emit('submitMinions', { roomId: currentRoomId, dispatchMap });
  
  const dispatchSection = document.getElementById('dispatch-section');
  if (dispatchSection) dispatchSection.classList.add('hidden');

  const waitMsg = document.getElementById('wait-msg');
  if (waitMsg) waitMsg.innerText = '✅ 陣容已提交，等待結算...';
}

function resolveTie(cellNo, selectId) {
  const selectEl = document.getElementById(selectId);
  if (!selectEl) return;
  const winnerPlayerId = selectEl.value;
  socket.emit('resolveTie', { roomId: currentRoomId, cellNo, winnerPlayerId });
}

function renderPlayerList(players) {
  if (!players || !Array.isArray(players)) return;
  totalPlayersCount = players.length;
  const sorted = [...players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

  const hostList = document.getElementById('player-list');
  if (hostList) {
    hostList.innerHTML = '';
    sorted.forEach((p, idx) => {
      hostList.innerHTML += `
        <li class="player-item" id="p-${p.id}">
          <div style="display:flex; align-items:center;">
            <img src="${p.avatar || p.characterAvatar || '/images/default.png'}" class="player-avatar">
            <span><b>第 ${idx + 1} 名</b> | ${p.name || p.playerName} (${p.cellNo} 號牢房)</span>
          </div>
          <span class="badge">${p.totalScore || 0} 分</span>
        </li>`;
    });
  }

  const playerList = document.getElementById('player-score-list');
  if (playerList) {
    playerList.innerHTML = '';
    sorted.forEach((p, idx) => {
      const isMe = Number(p.cellNo) === Number(myCellNo) ? ' (你)' : '';
      playerList.innerHTML += `
        <li class="player-item" style="${Number(p.cellNo) === Number(myCellNo) ? 'border: 1px solid #38bdf8;' : ''}">
          <div style="display:flex; align-items:center;">
            <img src="${p.avatar || p.characterAvatar || '/images/default.png'}" class="player-avatar">
            <span><b>第 ${idx + 1} 名</b> | ${p.name || p.playerName} (${p.cellNo} 號牢房)${isMe}</span>
          </div>
          <span class="badge" style="background:#38bdf8; color:#0f172a;">${p.totalScore || 0} 分</span>
        </li>`;
    });
  }
}

// --- Socket.IO 監聽事件 ---

socket.on('roomCreated', (data) => {
  currentRoomId = data.roomId;
  const roomDisplay = document.getElementById('room-code-display');
  if (roomDisplay) roomDisplay.innerText = data.roomId;

  const qrContainer = document.getElementById('qrcode');
  if (qrContainer && typeof QRCode !== 'undefined') {
    qrContainer.innerHTML = '';
    const joinUrl = `${window.location.origin}`;
    new QRCode(qrContainer, {
      text: joinUrl,
      width: 140,
      height: 140,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  }

  const qrSection = document.getElementById('qrcode-section');
  if (qrSection) {
    qrSection.classList.remove('hidden');
    qrSection.style.display = 'block';
  }
});

socket.on('updateTakenCharacters', (takenIds) => {
  takenCharacterIds = takenIds || [];
  renderCharacterSelect();
});

socket.on('joinSuccess', (data) => {
  currentRoomId = data.roomId;
  myCellNo = data.cellNo;

  const playerCellInfo = document.getElementById('player-cell-info');
  if (playerCellInfo) playerCellInfo.innerText = `${data.playerName} (${data.cellNo} 號牢房)`;

  const myAvatarDisplay = document.getElementById('my-avatar-display');
  if (myAvatarDisplay) myAvatarDisplay.src = data.characterAvatar;

  showScreen('player-game-screen');
  
  // 💡 自動預載一次選單，確保進遊戲就有選單預備
  initSelects(8, null);
});

socket.on('errorMessage', (msg) => {
  alert(msg);
});

socket.on('updatePlayers', (players) => {
  renderPlayerList(players);
  const playerCount = document.getElementById('player-count');
  const cellCount = document.getElementById('cell-count');
  if (playerCount) playerCount.innerText = players.length;
  if (cellCount) cellCount.innerText = players.length;
  
  // 每次更新人數，同步刷新選單數量上限
  initSelects(players.length, currentDisabledMinion);
});

socket.on('hostBonusNotice', (data) => {
  const bonusCell = data.bonusCell;
  const submittedCount = data.submittedCount || 0;
  const totalPlayers = data.totalPlayers || totalPlayersCount;

  const secretBonusCell = document.getElementById('secret-bonus-cell');
  if (secretBonusCell && bonusCell) secretBonusCell.innerText = bonusCell;

  const submitProgress = document.getElementById('submit-progress');
  if (submitProgress) submitProgress.innerText = `提交進度：${submittedCount} / ${totalPlayers} 人`;

  const hostSecretBox = document.getElementById('host-secret-box');
  if (hostSecretBox) hostSecretBox.classList.remove('hidden');
});

socket.on('playerSubmittedNotice', (data) => {
  const submittedCount = data.submittedCount || 0;
  const totalPlayers = data.totalPlayers || totalPlayersCount;
  const submitProgress = document.getElementById('submit-progress');
  if (submitProgress) submitProgress.innerText = `提交進度：${submittedCount} / ${totalPlayers} 人`;
});

socket.on('playerRoundConfig', (data) => {
  const disabledMinion = data ? data.disabledMinion : null;
  currentDisabledMinion = disabledMinion;
  initSelects(totalPlayersCount, currentDisabledMinion);
});

// ✅ 回合開始事件 (包含兼顧舊架構的多重相容)
function handleRoundStart(data) {
  data = data || {};
  currentRound = data.round || 1;
  const maxRounds = data.maxRounds || 5;
  const totalCells = data.totalCells || totalPlayersCount || 8;
  const eventInfo = data.eventInfo;

  currentDisabledMinion = null;

  const qrSection = document.getElementById('qrcode-section');
  if (qrSection) {
    qrSection.classList.add('hidden');
    qrSection.style.display = 'none';
  }

  const startBtn = document.getElementById('start-round-btn');
  if (startBtn) startBtn.classList.add('hidden');

  const calcBtn = document.getElementById('calc-round-btn');
  if (calcBtn) calcBtn.classList.remove('hidden');

  const hostResults = document.getElementById('host-results');
  if (hostResults) hostResults.innerHTML = '';

  const hostTieBox = document.getElementById('host-tie-box');
  if (hostTieBox) hostTieBox.classList.add('hidden');

  const tieControls = document.getElementById('tie-controls');
  if (tieControls) tieControls.innerHTML = '';

  const hostEventBanner = document.getElementById('host-event-banner');
  const hostEventDesc = document.getElementById('host-event-desc');
  if (eventInfo && eventInfo.description) {
    if (hostEventDesc) hostEventDesc.innerText = eventInfo.description;
    if (hostEventBanner) hostEventBanner.classList.remove('hidden');
  } else if (hostEventBanner) {
    hostEventBanner.classList.add('hidden');
  }

  const roundDisplay = document.getElementById('round-display');
  if (roundDisplay) roundDisplay.innerText = `第 ${currentRound} / ${maxRounds} 回合爭奪開始！`;

  const waitMsg = document.getElementById('wait-msg');
  if (waitMsg) waitMsg.innerText = '';

  const playerResults = document.getElementById('player-results');
  if (playerResults) playerResults.innerHTML = '';

  // 1. 初始化選單
  initSelects(totalCells, null);

  // 2. 顯示派遣區域
  const dispatchSection = document.getElementById('dispatch-section');
  if (dispatchSection) dispatchSection.classList.remove('hidden');

  const playerEventBanner = document.getElementById('player-event-banner');
  const playerEventDesc = document.getElementById('player-event-desc');
  if (eventInfo && eventInfo.description) {
    if (playerEventDesc) playerEventDesc.innerText = eventInfo.description;
    if (playerEventBanner) playerEventBanner.classList.remove('hidden');
  } else if (playerEventBanner) {
    playerEventBanner.classList.add('hidden');
  }
}

// 監聽常見的回合開始命名
socket.on('roundStarted', handleRoundStart);
socket.on('startRound', handleRoundStart);

socket.on('roundRevealed', ({ round, maxRounds, isLastRound, bonusCell, totalCells, summary, players, tiesToResolve }) => {
  renderPlayerList(players);

  const calcBtn = document.getElementById('calc-round-btn');
  const startBtn = document.getElementById('start-round-btn');

  if (isLastRound) {
    if (calcBtn) calcBtn.classList.add('hidden');
    if (startBtn) startBtn.classList.add('hidden');
  } else {
    if (calcBtn) calcBtn.classList.add('hidden');
    if (startBtn) {
      startBtn.classList.remove('hidden');
      startBtn.innerText = `開始第 ${(round || currentRound) + 1} 回合`;
    }
  }

  const tieBox = document.getElementById('host-tie-box');
  const tieControls = document.getElementById('tie-controls');
  if (tieControls) tieControls.innerHTML = '';

  if (tiesToResolve && tiesToResolve.length > 0) {
    if (tieBox) tieBox.classList.remove('hidden');
    tiesToResolve.forEach(item => {
      let optionsHtml = item.tiedPlayers.map(p => `<option value="${p.id}">${p.name || p.playerName}</option>`).join('');
      if (tieControls) {
        tieControls.innerHTML += `
          <div class="tie-row">
            <p style="color:#e9d5ff; font-size:14px; margin-bottom:4px;">⚠️ <b>${item.cellNo} 號牢房</b> 平手爭奪中 (${item.points} 分)：</p>
            <div style="display:flex; gap:8px;">
              <select id="tie-select-${item.cellNo}" style="margin:0; padding:6px;">${optionsHtml}</select>
              <button class="btn-success" style="width:auto; margin:0; padding:6px 12px; font-size:14px;" onclick="resolveTie(${item.cellNo}, 'tie-select-${item.cellNo}')">決定分數</button>
            </div>
          </div>`;
      }
    });
  } else {
    if (tieBox) tieBox.classList.add('hidden');
  }

  function renderCards(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const cellLimit = totalCells || totalPlayersCount || 8;
    container.innerHTML = `<h3 style="margin-bottom:10px; color:#38bdf8;">第 ${round || currentRound} 回合戰果揭曉：</h3>`;

    for (let i = 1; i <= cellLimit; i++) {
      const info = summary ? summary[i] : null;
      if (!info) continue;
      const isBonus = i === bonusCell;
      let statusText = '';

      if (info.status === 'WIN') {
        const isDefenseSuccess = Number(info.winnerCellNo) === Number(i);
        const roleTitle = isDefenseSuccess ? '房主' : '搶奪者';
        const actionText = isDefenseSuccess ? '防守成功!' : '搶奪成功!';

        statusText = `<span style="color:#4ade80; font-weight:bold;">🏆 ${roleTitle} ${info.winnerName} (${info.power} 點戰力) ${actionText} 獨得 ${info.points} 糧食!</span>`;
      } else if (info.status === 'TIE') {
        statusText = `<span style="color:#c084fc; font-weight:bold;">⚖️ 平手待裁決 (${info.power} 點戰力)</span>`;
      } else {
        statusText = `<span style="color:#94a3b8;">⚪無人爭奪</span>`;
      }

      let detailsHtml = '';
      if (info.details && info.details.length > 0) {
        detailsHtml = `<div class="detail-list"><b>⚔️ 各玩家派駐戰力分佈：</b><br>` + 
          info.details.map(d => `• ${d.playerName} (來自 ${d.fromCellNo} 號牢房)：派出 ${d.power} 點戰力`).join('<br>') + 
          `</div>`;
      } else {
        detailsHtml = `<div class="detail-list">⚔️無玩家派駐戰力</div>`;
      }

      const cellTitleName = info.ownerName ? ` (${info.ownerName})` : '';

      container.innerHTML += `
        <div class="cell-card" style="${info.isDouble ? 'border: 2px solid #f59e0b; background: #451a03;' : ''}">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <b style="font-size:16px;">📍 ${i} 號牢房${cellTitleName}</b>
            <span style="color:#f59e0b; font-weight:bold;">糧食分數：${info.points} 分 ${info.isDouble ? '🔥(雙倍爆發!)' : ''} ${isBonus ? '⭐(Bonus牢房)' : ''}</span>
          </div>
          <div>${statusText}</div>
          ${detailsHtml}
        </div>`;
    }
  }

  renderCards('host-results');
  renderCards('player-results');

  const gameStatusBox = document.getElementById('game-status-box');
  if (gameStatusBox) gameStatusBox.innerHTML = `<p style="color:#4ade80; font-weight:bold;">第 ${round || currentRound} 回合結算完成！</p>`;
});

socket.on('tieResolved', ({ cellNo, winnerName, players }) => {
  renderPlayerList(players);
  alert(`⚖️ ${cellNo} 號牢房平手裁決完畢！由 ${winnerName} 獲得該牢房糧食！`);
});

socket.on('gameOver', ({ message }) => {
  alert(message || '遊戲結束！');
  const qrSection = document.getElementById('qrcode-section');
  if (qrSection) {
    qrSection.classList.add('hidden');
    qrSection.style.display = 'none';
  }
  const gameStatusBox = document.getElementById('game-status-box');
  if (gameStatusBox) gameStatusBox.innerHTML = `<h2 style="color:#f59e0b;">🎉 遊戲結束！</h2>`;
});