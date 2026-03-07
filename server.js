const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Quản lý dữ liệu toàn bộ các phòng: { "123456": { players: [], host: id, isPlaying: false, turn: 0 } }
const rooms = {};
const socketToRoom = {};

function generateRoomCode() {
    let code;
    do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    console.log('🟢 Người chơi kết nối:', socket.id);

    // 1. TẠO PHÒNG MỚI
    socket.on('create_room', (pInfo) => {
        const roomId = generateRoomCode();
        socket.join(roomId);
        socketToRoom[socket.id] = roomId;

        const newPlayer = {
            id: socket.id,
            name: pInfo.name, avatar: pInfo.avatar, color: pInfo.color,
            isReady: true, // Chủ phòng luôn ready
            score: 500, pos: 0, jail: false, qCount: 0
        };

        rooms[roomId] = {
            id: roomId,
            host: socket.id,
            players: [newPlayer],
            isPlaying: false,
            currentTurnIdx: 0
        };

        socket.emit('room_created', roomId);
        io.to(roomId).emit('update_lobby', rooms[roomId]);
    });

    // 2. VÀO PHÒNG BẰNG MÃ
    socket.on('join_room', (data) => {
        const { roomId, pInfo } = data;
        const room = rooms[roomId];

        if (!room) return socket.emit('error_msg', "Mã phòng không tồn tại!");
        if (room.isPlaying) return socket.emit('error_msg', "Phòng này đang chơi rồi!");
        if (room.players.length >= 4) return socket.emit('error_msg', "Phòng đã đầy (Max 4)!");

        socket.join(roomId);
        socketToRoom[socket.id] = roomId;

        const newPlayer = {
            id: socket.id,
            name: pInfo.name, avatar: pInfo.avatar, color: pInfo.color,
            isReady: false, score: 500, pos: 0, jail: false, qCount: 0
        };

        room.players.push(newPlayer);
        io.to(roomId).emit('update_lobby', room);
    });

    // 3. NÚT SẴN SÀNG
    socket.on('toggle_ready', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (player && room.host !== socket.id) { // Host không cần nút này
                player.isReady = !player.isReady;
                io.to(roomId).emit('update_lobby', room);
            }
        }
    });

    // 4. CHỦ PHÒNG BẮT ĐẦU GAME
    socket.on('start_game', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            if (room.host !== socket.id) return;

            const allReady = room.players.every(p => p.isReady);
            if (!allReady) return socket.emit('error_msg', "Chưa phải tất cả đều Sẵn sàng!");
            if (room.players.length < 2) return socket.emit('error_msg', "Cần ít nhất 2 người!");

            room.isPlaying = true;
            io.to(roomId).emit('game_started', room);
        }
    });

    // 5. ĐỔ XÚC XẮC NGẪU NHIÊN 100%
    socket.on('request_roll', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const currentPlayer = room.players[room.currentTurnIdx];

            if (currentPlayer && currentPlayer.id === socket.id) {
                const val = Math.floor(Math.random() * 6) + 1;
                io.to(roomId).emit('dice_rolled', { value: val, playerId: socket.id });
            } else {
                socket.emit('error_msg', "Chưa tới lượt của bạn!");
            }
        }
    });

    // 6. ĐỒNG BỘ TRẢ LỜI CÂU HỎI VÀ TIỀN BẠC ---
    socket.on('answering_event', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId) socket.to(roomId).emit('player_is_answering', socket.id);
    });

    socket.on('answered_result', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) {
                p.score += data.points;
                if (!data.isBonus) p.qCount++;
                io.to(roomId).emit('sync_players', room.players);

                if (!data.isBonus) {
                    io.to(roomId).emit('log_msg', `${data.correct ? '✅' : '❌'} <b>${p.avatar} ${p.name}</b> trả lời ${data.correct ? 'ĐÚNG (+' + data.points + 'đ)' : 'SAI'}!`);
                }
            }
        }
    });

    // 7. MUA ĐẤT & TRẢ TIỀN THUÊ
    socket.on('property_action', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) {
                p.score -= data.cost;
                io.to(roomId).emit('sync_players', room.players);
                io.to(roomId).emit('sync_board', { ...data, playerId: p.id });
            }
        }
    });

    socket.on('pay_rent', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const payer = room.players.find(p => p.id === socket.id);
            const payee = room.players.find(p => p.id === data.ownerId);

            if (payer && payee) {
                payer.score -= data.amount;
                payee.score += data.amount;
                io.to(roomId).emit('sync_players', room.players);
                io.to(roomId).emit('log_msg', `💸 <b>${payer.avatar} ${payer.name}</b> vừa nộp ${data.amount}đ tiền thuê cho <b>${payee.name}</b>!`);
            }
        }
    });

    // 8. CHUYỂN LƯỢT
    socket.on('next_turn', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const currentPlayer = room.players[room.currentTurnIdx];
            if (currentPlayer && currentPlayer.id === socket.id) {
                room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
                io.to(roomId).emit('turn_changed', room.currentTurnIdx);
            }
        }
    });

    // 9. THOÁT GAME
    socket.on('disconnect', () => {
        console.log('🔴 Người chơi thoát:', socket.id);
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            let room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                if (room.host === socket.id) {
                    room.host = room.players[0].id;
                    room.players[0].isReady = true;
                }
                if (room.isPlaying && room.currentTurnIdx >= room.players.length) {
                    room.currentTurnIdx = 0;
                }
                io.to(roomId).emit('update_lobby', room);
            }
        }
        delete socketToRoom[socket.id];
    });
});

// Lấy cổng tự động của Server cloud, nếu không có thì dùng 3000 (để test ở máy)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server EngQuest Online đang chạy tại cổng ${PORT}`);
});