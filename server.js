const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const socketToRoom = {};

function generateRoomCode() {
    let code;
    do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]);
    return code;
}

// Hàm hỗ trợ: Nhận diện xem lệnh được gửi cho Người thật hay Bot
function getActor(room, socketId, targetId) {
    if (targetId && room.host === socketId) {
        return room.players.find(p => p.id === targetId && p.isBot);
    }
    return room.players.find(p => p.id === socketId);
}

io.on('connection', (socket) => {
    console.log('🟢 Khách truy cập:', socket.id);

    // --- TẠO PHÒNG CHƠI VỚI BOT ---
    socket.on('play_with_bot', (pInfo) => {
        const roomId = generateRoomCode();
        socket.join(roomId);
        socketToRoom[socket.id] = roomId;

        const newPlayer = { id: socket.id, username: pInfo.username, avatar: pInfo.avatar, color: pInfo.color, isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: false };
        const botPlayer = { id: 'bot_' + Math.random().toString(36).substr(2, 9), username: 'Bot Thông Thái', avatar: '🤖', color: '#00cec9', isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: true };

        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer, botPlayer], isPlaying: true, currentTurnIdx: 0 };
        socket.emit('room_created', roomId);
        io.to(roomId).emit('update_lobby', rooms[roomId]);
        // Bắt đầu game ngay lập tức
        io.to(roomId).emit('game_started', rooms[roomId]);
    });

    // --- LOBBY CHUNG ---
    socket.on('create_room', (pInfo) => {
        const roomId = generateRoomCode();
        socket.join(roomId); socketToRoom[socket.id] = roomId;
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: pInfo.avatar, color: pInfo.color, isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: false };
        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer], isPlaying: false, currentTurnIdx: 0 };
        socket.emit('room_created', roomId); io.to(roomId).emit('update_lobby', rooms[roomId]);
    });

    socket.on('join_room', (data) => {
        const { roomId, pInfo } = data; const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', "Mã phòng không tồn tại!");
        if (room.isPlaying) return socket.emit('error_msg', "Phòng đang chơi rồi!");
        if (room.players.length >= 4) return socket.emit('error_msg', "Phòng đã đầy!");
        socket.join(roomId); socketToRoom[socket.id] = roomId;
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: pInfo.avatar, color: pInfo.color, isReady: false, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: false };
        room.players.push(newPlayer); io.to(roomId).emit('update_lobby', room);
    });

    socket.on('toggle_ready', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
            if (player && room.host !== socket.id) { player.isReady = !player.isReady; io.to(roomId).emit('update_lobby', room); }
        }
    });

    socket.on('start_game', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; if (room.host !== socket.id) return;
            if (!room.players.every(p => p.isReady)) return socket.emit('error_msg', "Chưa Sẵn sàng hết!");
            if (room.players.length < 2) return socket.emit('error_msg', "Cần ít nhất 2 người!");
            room.isPlaying = true; io.to(roomId).emit('game_started', room);
        }
    });

    // --- GAME LOGIC ---
    socket.on('request_roll', (targetId) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) {
                const val = Math.floor(Math.random() * 6) + 1;
                io.to(roomId).emit('dice_rolled', { value: val, playerId: actor.id });
            }
        }
    });

    socket.on('movement_complete', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId); const finalPos = data.pos;
            if (p) {
                if (p.pos > finalPos && finalPos < 12) {
                    p.score += 200; io.to(roomId).emit('log_msg', `✅ <b>${p.avatar} ${p.username}</b> qua cờ GO (+200đ)`);
                }
                p.pos = finalPos; io.to(roomId).emit('sync_players', room.players);
            }
        }
    });

    socket.on('answering_event', (targetId) => {
        const roomId = socketToRoom[socket.id];
        if (roomId) {
            const p = getActor(rooms[roomId], socket.id, targetId);
            if (p) socket.to(roomId).emit('player_is_answering', p.id);
        }
    });

    socket.on('answered_result', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId);
            if (p) {
                p.score += data.points;
                if (!data.isBonus) {
                    p.qCount++;
                    if (data.correct) p.currentStreak++; else p.currentStreak = 0;
                    io.to(roomId).emit('log_msg', `${data.correct ? '✅' : '❌'} <b>${p.avatar} ${p.username}</b> trả lời ${data.correct ? 'ĐÚNG' : 'SAI'}! (Chuỗi: ${p.currentStreak})`);
                }
                io.to(roomId).emit('sync_players', room.players);
            }
        }
    });

    socket.on('property_action', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId);
            if (p) {
                p.score -= data.cost; io.to(roomId).emit('sync_players', room.players);
                io.to(roomId).emit('sync_board', { action: data.action, tileIndex: data.tileIndex, playerId: p.id, playerName: p.username });
            }
        }
    });

    socket.on('pay_rent', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const payer = getActor(room, socket.id, data.targetId); const payee = room.players.find(x => x.id === data.ownerId);
            if (payer && payee) {
                payer.score -= data.amount; payee.score += data.amount;
                io.to(roomId).emit('sync_players', room.players);
                io.to(roomId).emit('log_msg', `💸 <b>${payer.avatar} ${payer.username}</b> nộp ${data.amount}đ cho <b>${payee.username}</b>!`);
            }
        }
    });

    socket.on('next_turn', (targetId) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) {
                room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
                io.to(roomId).emit('turn_changed', room.currentTurnIdx);
            }
        }
    });

    socket.on('end_game', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; if (room.host !== socket.id) return;
            let winner = room.players[0]; room.players.forEach(p => { if (p.score > winner.score) winner = p; });
            io.to(roomId).emit('game_over', { winnerName: winner.username, score: winner.score });
            room.isPlaying = false; room.players.forEach(p => { p.isReady = (p.id === room.host || p.isBot); p.score = 500; p.pos = 0; p.currentStreak = 0; });
        }
    });

    socket.on('disconnect', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            let room = rooms[roomId];
            const droppedName = room.players.find(p => p.id === socket.id)?.username || "Ai đó";
            room.players = room.players.filter(p => p.id !== socket.id);

            // Xóa phòng nếu không còn người thật nào
            const realPlayers = room.players.filter(p => !p.isBot);
            if (realPlayers.length === 0) {
                delete rooms[roomId];
            } else {
                if (room.host === socket.id) { room.host = realPlayers[0].id; realPlayers[0].isReady = true; }
                if (room.isPlaying) {
                    if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
                    io.to(roomId).emit('player_dropped', { players: room.players, turn: room.currentTurnIdx });
                    io.to(roomId).emit('log_msg', `🔴 <b>${droppedName}</b> mất kết nối!`);
                } else {
                    io.to(roomId).emit('update_lobby', room);
                }
            }
        }
        delete socketToRoom[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server EngQuest Online đang chạy tại cổng ${PORT}`));