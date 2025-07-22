const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // 静的ファイル配信

// ユーザーとゲームデータの管理
const users = new Map();
const gameRooms = new Map();

// ポーカーのカードデッキ作成
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  
  for (let suit of suits) {
    for (let value of values) {
      deck.push({ 
        value, 
        suit, 
        color: (suit === '♥' || suit === '♦') ? 'red' : 'black'
      });
    }
  }
  
  return shuffleDeck(deck);
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ゲームルーム作成
function createGameRoom(roomId, bigBlind) {
  return {
    id: roomId,
    players: [],
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    bigBlind: bigBlind,
    smallBlind: bigBlind / 2,
    dealerIndex: 0,
    currentPlayerIndex: -1,
    phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
    maxPlayers: 6
  };
}

// ルート設定
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Socket.IO イベントハンドラー
io.on('connection', (socket) => {
  console.log('新しいユーザーが接続しました:', socket.id);
  
  // 認証処理
  socket.on('authenticate', (data) => {
    const { userId, password, isRegistration } = data;
    
    if (isRegistration) {
      // 新規登録
      if (users.has(userId)) {
        socket.emit('auth-error', 'このユーザーIDは既に使用されています');
        return;
      }
      
      users.set(userId, {
        id: userId,
        password: password,
        chips: 10000,
        socketId: socket.id
      });
      
      socket.emit('auth-success', {
        userId: userId,
        chips: 10000
      });
    } else {
      // ログイン
      const user = users.get(userId);
      if (!user || user.password !== password) {
        socket.emit('auth-error', 'ユーザーIDまたはパスワードが間違っています');
        return;
      }
      
      user.socketId = socket.id;
      socket.emit('auth-success', {
        userId: userId,
        chips: user.chips
      });
    }
    
    socket.userId = userId;
    updateLobbyInfo();
  });
  
  // ルーム参加
  socket.on('join-room', (data) => {
    const { roomId, bigBlind } = data;
    const user = users.get(socket.userId);
    
    if (!user) {
      socket.emit('error', '認証が必要です');
      return;
    }
    
    if (user.chips < bigBlind * 10) {
      socket.emit('error', 'チップが不足しています');
      return;
    }
    
    // ルームが存在しない場合は作成
    if (!gameRooms.has(roomId)) {
      gameRooms.set(roomId, createGameRoom(roomId, bigBlind));
    }
    
    const room = gameRooms.get(roomId);
    
    // プレイヤーがすでに参加していないかチェック
    const existingPlayer = room.players.find(p => p.userId === socket.userId);
    if (existingPlayer) {
      socket.emit('error', '既にこのルームに参加しています');
      return;
    }
    
    if (room.players.length >= room.maxPlayers) {
      socket.emit('error', 'ルームが満員です');
      return;
    }
    
    // プレイヤーをルームに追加
    const player = {
      userId: socket.userId,
      socketId: socket.id,
      chips: user.chips,
      cards: [],
      bet: 0,
      folded: false,
      allIn: false
    };
    
    room.players.push(player);
    socket.join(`room-${roomId}`);
    socket.currentRoom = roomId;
    
    // ルーム情報を送信
    socket.emit('joined-room', {
      roomId: roomId,
      room: sanitizeRoomForClient(room, socket.userId)
    });
    
    // 他のプレイヤーに通知
    socket.to(`room-${roomId}`).emit('player-joined', {
      player: { userId: player.userId, chips: player.chips }
    });
    
    updateLobbyInfo();
    
    // 2人以上いればゲーム開始
    if (room.players.length >= 2 && room.phase === 'waiting') {
      setTimeout(() => startNewGame(roomId), 3000);
    }
  });
  
  // プレイヤーアクション
  socket.on('player-action', (data) => {
    const { action, amount } = data;
    const roomId = socket.currentRoom;
    
    if (!roomId) return;
    
    const room = gameRooms.get(roomId);
    if (!room) return;
    
    const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === -1 || playerIndex !== room.currentPlayerIndex) return;
    
    const player = room.players[playerIndex];
    const user = users.get(socket.userId);
    
    switch (action) {
      case 'fold':
        player.folded = true;
        break;
        
      case 'call':
        const callAmount = room.currentBet - player.bet;
        const actualCallAmount = Math.min(callAmount, player.chips);
        player.bet += actualCallAmount;
        player.chips -= actualCallAmount;
        room.pot += actualCallAmount;
        user.chips = player.chips;
        break;
        
      case 'raise':
        const raiseAmount = parseInt(amount) || room.bigBlind;
        const totalBet = room.currentBet + raiseAmount;
        const playerRaise = totalBet - player.bet;
        const actualRaise = Math.min(playerRaise, player.chips);
        player.bet += actualRaise;
        player.chips -= actualRaise;
        room.pot += actualRaise;
        room.currentBet = player.bet;
        user.chips = player.chips;
        break;
        
      case 'check':
        // 何もしない（ベットが必要な場合はコールと同じ処理）
        if (room.currentBet > player.bet) {
          const callAmount = room.currentBet - player.bet;
          const actualCallAmount = Math.min(callAmount, player.chips);
          player.bet += actualCallAmount;
          player.chips -= actualCallAmount;
          room.pot += actualCallAmount;
          user.chips = player.chips;
        }
        break;
        
      case 'all-in':
        room.pot += player.chips;
        player.bet += player.chips;
        player.chips = 0;
        player.allIn = true;
        user.chips = 0;
        if (player.bet > room.currentBet) {
          room.currentBet = player.bet;
        }
        break;
    }
    
    // 次のプレイヤーに移動
    nextPlayer(roomId);
  });
  
  // ルーム退出
  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });
  
  // 切断処理
  socket.on('disconnect', () => {
    console.log('ユーザーが切断しました:', socket.id);
    leaveCurrentRoom(socket);
    
    // ユーザーのソケットIDをクリア
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user && user.socketId === socket.id) {
        user.socketId = null;
      }
    }
  });
});

// ヘルパー関数
function leaveCurrentRoom(socket) {
  const roomId = socket.currentRoom;
  if (!roomId) return;
  
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
  if (playerIndex !== -1) {
    room.players.splice(playerIndex, 1);
    socket.leave(`room-${roomId}`);
    socket.to(`room-${roomId}`).emit('player-left', { userId: socket.userId });
    
    if (room.players.length === 0) {
      gameRooms.delete(roomId);
    }
  }
  
  socket.currentRoom = null;
  updateLobbyInfo();
}

function startNewGame(roomId) {
  const room = gameRooms.get(roomId);
  if (!room || room.players.length < 2) return;
  
  // ゲーム状態をリセット
  room.deck = createDeck();
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = room.bigBlind;
  room.phase = 'preflop';
  
  // プレイヤー状態をリセット
  room.players.forEach((player, index) => {
    player.cards = [];
    player.bet = 0;
    player.folded = false;
    player.allIn = false;
    
    // スモールブラインドとビッグブラインド
    if (index === (room.dealerIndex + 1) % room.players.length) {
      player.bet = room.smallBlind;
      player.chips -= room.smallBlind;
      room.pot += room.smallBlind;
      const user = users.get(player.userId);
      if (user) user.chips = player.chips;
    } else if (index === (room.dealerIndex + 2) % room.players.length) {
      player.bet = room.bigBlind;
      player.chips -= room.bigBlind;
      room.pot += room.bigBlind;
      const user = users.get(player.userId);
      if (user) user.chips = player.chips;
    }
  });
  
  // 各プレイヤーにカードを配る
  for (let i = 0; i < 2; i++) {
    room.players.forEach(player => {
      if (room.deck.length > 0) {
        player.cards.push(room.deck.pop());
      }
    });
  }
  
  room.currentPlayerIndex = (room.dealerIndex + 3) % room.players.length;
  
  // ゲーム開始を通知
  io.to(`room-${roomId}`).emit('game-started', {
    room: sanitizeRoomForClients(room)
  });
  
  updateGameState(roomId);
}

function nextPlayer(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  // 次のアクティブなプレイヤーを見つける
  let nextIndex = (room.currentPlayerIndex + 1) % room.players.length;
  let attempts = 0;
  
  while (attempts < room.players.length) {
    const player = room.players[nextIndex];
    if (!player.folded && !player.allIn && player.chips > 0) {
      room.currentPlayerIndex = nextIndex;
      updateGameState(roomId);
      return;
    }
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
  }
  
  // 次のフェーズに移行
  nextPhase(roomId);
}

function nextPhase(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  // 全プレイヤーのベットをリセット
  room.players.forEach(player => {
    player.bet = 0;
  });
  room.currentBet = 0;
  
  switch (room.phase) {
    case 'preflop':
      room.phase = 'flop';
      // フロップ：3枚のコミュニティカードを配る
      for (let i = 0; i < 3; i++) {
        if (room.deck.length > 0) {
          room.communityCards.push(room.deck.pop());
        }
      }
      break;
      
    case 'flop':
      room.phase = 'turn';
      // ターン：4枚目のコミュニティカード
      if (room.deck.length > 0) {
        room.communityCards.push(room.deck.pop());
      }
      break;
      
    case 'turn':
      room.phase = 'river';
      // リバー：5枚目のコミュニティカード
      if (room.deck.length > 0) {
        room.communityCards.push(room.deck.pop());
      }
      break;
      
    case 'river':
      room.phase = 'showdown';
      endGame(roomId);
      return;
  }
  
  room.currentPlayerIndex = room.dealerIndex;
  nextPlayer(roomId);
}

function endGame(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  // 勝者決定とポット分配のロジック（簡単な実装）
  const activePlayers = room.players.filter(p => !p.folded);
  
  if (activePlayers.length === 1) {
    // 一人だけ残った場合
    const winner = activePlayers[0];
    winner.chips += room.pot;
    const user = users.get(winner.userId);
    if (user) user.chips = winner.chips;
    
    io.to(`room-${roomId}`).emit('game-ended', {
      winner: winner.userId,
      pot: room.pot,
      room: sanitizeRoomForClients(room)
    });
  } else {
    // 複数プレイヤーが残った場合（ランダムで勝者決定）
    const winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];
    winner.chips += room.pot;
    const user = users.get(winner.userId);
    if (user) user.chips = winner.chips;
    
    io.to(`room-${roomId}`).emit('game-ended', {
      winner: winner.userId,
      pot: room.pot,
      room: sanitizeRoomForClients(room)
    });
  }
  
  // 次のゲームの準備
  room.phase = 'waiting';
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  
  setTimeout(() => {
    if (room.players.length >= 2) {
      startNewGame(roomId);
    }
  }, 5000);
}

function sanitizeRoomForClient(room, userId) {
  const clientRoom = {
    ...room,
    players: room.players.map(player => ({
      ...player,
      cards: player.userId === userId ? player.cards : player.cards.map(() => ({ hidden: true }))
    }))
  };
  return clientRoom;
}

function sanitizeRoomForClients(room) {
  return {
    ...room,
    players: room.players.map(player => ({
      ...player,
      cards: player.cards.map(() => ({ hidden: true }))
    }))
  };
}

function updateGameState(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  room.players.forEach(player => {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('game-update', {
        room: sanitizeRoomForClient(room, player.userId),
        isYourTurn: room.currentPlayerIndex === room.players.findIndex(p => p.userId === player.userId)
      });
    }
  });
}

function updateLobbyInfo() {
  const lobbyInfo = {
    rooms: Array.from(gameRooms.values()).map(room => ({
      id: room.id,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      bigBlind: room.bigBlind
    }))
  };
  
  io.emit('lobby-update', lobbyInfo);
}

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
  console.log(`Railway URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + PORT}`);
});
