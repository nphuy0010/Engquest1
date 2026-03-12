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
    let code; do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]); return code;
}

function getActor(room, socketId, targetId) {
    if (targetId && room.host === socketId) return room.players.find(p => p.id === targetId && p.isBot);
    return room.players.find(p => p.id === socketId);
}

io.on('connection', (socket) => {
    // --- LOBBY & ROOM LOGIC ---
    socket.on('play_with_bot', (pInfo) => {
        const roomId = generateRoomCode(); socket.join(roomId); socketToRoom[socket.id] = roomId;
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: pInfo.avatar, color: pInfo.color, isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: false };
        const botPlayer = { id: 'bot_' + Math.random().toString(36).substr(2, 9), username: 'Máy (AI)', avatar: '🤖', color: '#00cec9', isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: true };
        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer, botPlayer], isPlaying: true, currentTurnIdx: 0, stealData: null };
        socket.emit('room_created', roomId); io.to(roomId).emit('update_lobby', rooms[roomId]); io.to(roomId).emit('game_started', rooms[roomId]);
    });

    socket.on('create_room', (pInfo) => {
        const roomId = generateRoomCode(); socket.join(roomId); socketToRoom[socket.id] = roomId;
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: pInfo.avatar, color: pInfo.color, isReady: true, score: 500, pos: 0, jail: false, qCount: 0, currentStreak: 0, isBot: false };
        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer], isPlaying: false, currentTurnIdx: 0, stealData: null };
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
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
            if (player && room.host !== socket.id) { player.isReady = !player.isReady; io.to(roomId).emit('update_lobby', room); }
        }
    });

    socket.on('start_game', () => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; if (room.host !== socket.id) return;
            if (!room.players.every(p => p.isReady)) return socket.emit('error_msg', "Chưa Sẵn sàng hết!");
            if (room.players.length < 2) return socket.emit('error_msg', "Cần ít nhất 2 người!");
            room.isPlaying = true; io.to(roomId).emit('game_started', room);
        }
    });

    // --- GAME MOVEMENT & JAIL LOGIC ---
    socket.on('request_roll', (targetId) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) {
                const val = Math.floor(Math.random() * 6) + 1;

                // KIỂM TRA LUẬT TRONG TÙ
                if (actor.jail) {
                    if (val === 6) {
                        actor.jail = false; // Thoát tù thành công
                        io.to(roomId).emit('sync_players', room.players);
                        io.to(roomId).emit('dice_rolled', { value: val, playerId: actor.id, escaped: true });
                    } else {
                        // Đổ không ra 6, tiếp tục ở tù
                        io.to(roomId).emit('dice_rolled', { value: val, playerId: actor.id, remainInJail: true });
                    }
                } else {
                    io.to(roomId).emit('dice_rolled', { value: val, playerId: actor.id });
                }
            }
        }
    });

    socket.on('player_jailed', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const p = getActor(rooms[roomId], socket.id, data.targetId);
            if (p) {
                p.jail = true;
                io.to(roomId).emit('sync_players', rooms[roomId].players);
            }
        }
    });

    socket.on('movement_complete', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId); const finalPos = data.pos;
            if (p) {
                if (p.pos > finalPos && finalPos < 12) { p.score += 200; io.to(roomId).emit('log_msg', `✅ <b>${p.avatar} ${p.username}</b> qua cờ GO (+200đ)`); }
                p.pos = finalPos; io.to(roomId).emit('sync_players', room.players);
            }
        }
    });

    // --- CHIA SẺ CÂU HỎI LÊN MÀN HÌNH CHUNG ---
    socket.on('share_question', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId) socket.to(roomId).emit('show_shared_question', data);
    });

    // --- XỬ LÝ KẾT QUẢ & CƯỚP CÂU HỎI ---
    socket.on('answered_result', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId);
            if (p) {
                if (data.isStealAnswer) {
                    if (data.correct) {
                        p.score += data.points; p.currentStreak++;
                        io.to(roomId).emit('log_msg', `🔥 Khét quá! <b>${p.avatar} ${p.username}</b> cướp thành công và nhận ${data.points}đ!`);
                    } else {
                        p.currentStreak = 0; io.to(roomId).emit('log_msg', `❌ <b>${p.avatar} ${p.username}</b> cướp hụt rồi!`);
                    }
                    io.to(roomId).emit('sync_players', room.players);
                    io.to(roomId).emit('resume_original_turn');
                    return;
                }

                if (!data.isBonus) p.qCount++;

                if (data.correct || data.isBonus) {
                    p.score += data.points; p.currentStreak++;
                    io.to(roomId).emit('log_msg', `${data.correct ? '✅' : '🍀'} <b>${p.avatar} ${p.username}</b> trả lời ${data.correct ? 'ĐÚNG' : 'MAY MẮN'}!`);
                    io.to(roomId).emit('sync_players', room.players);
                    socket.emit('process_property_action', { tileIndex: data.tileIndex });
                } else {
                    p.currentStreak = 0;
                    io.to(roomId).emit('log_msg', `❌ <b>${p.avatar} ${p.username}</b> trả lời SAI! Cơ hội cướp điểm bắt đầu!`);
                    io.to(roomId).emit('sync_players', room.players);

                    if (room.players.length > 1) {
                        const targetTime = (Math.random() * 4 + 3).toFixed(2);
                        room.stealData = { originalPlayerId: p.id, targetTime: parseFloat(targetTime), submissions: [], tileIndex: data.tileIndex, questionData: data.questionData };
                        io.to(roomId).emit('start_steal_clock', { targetTime, originalPlayerId: p.id, questionData: data.questionData });
                        setTimeout(() => { evaluateStealGame(roomId); }, 10000);
                    } else {
                        socket.emit('process_property_action', { tileIndex: data.tileIndex });
                    }
                }
            }
        }
    });

    socket.on('submit_steal_time', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId] && rooms[roomId].stealData) {
            const room = rooms[roomId]; const pId = data.targetId ? data.targetId : socket.id;
            if (pId === room.stealData.originalPlayerId || room.stealData.submissions.find(s => s.pId === pId)) return;
            room.stealData.submissions.push({ pId: pId, stoppedAt: data.stoppedAt });
            if (room.stealData.submissions.length >= room.players.length - 1) { evaluateStealGame(roomId); }
        }
    });

    function evaluateStealGame(roomId) {
        const room = rooms[roomId]; if (!room || !room.stealData) return;
        const sd = room.stealData; room.stealData = null;

        if (sd.submissions.length === 0) {
            io.to(roomId).emit('log_msg', `🕰️ Hết giờ! Không ai dám cướp câu này.`);
            io.to(roomId).emit('resume_original_turn'); return;
        }

        let winner = null; let minDiff = 9999;
        sd.submissions.forEach(sub => {
            const diff = Math.abs(sub.stoppedAt - sd.targetTime);
            if (diff < minDiff) { minDiff = diff; winner = sub.pId; }
        });

        const pWinner = room.players.find(p => p.id === winner);
        io.to(roomId).emit('log_msg', `⏱️ <b>${pWinner.username}</b> bấm đồng hồ chuẩn nhất (Sai số: ${minDiff.toFixed(2)}s) và giành quyền CƯỚP!`);
        io.to(roomId).emit('steal_winner_selected', { winnerId: winner, questionData: sd.questionData });
    }

    // --- BẤT ĐỘNG SẢN & KẾT THÚC ---
    socket.on('property_action', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const p = getActor(rooms[roomId], socket.id, data.targetId);
            if (p) { p.score -= data.cost; io.to(roomId).emit('sync_players', rooms[roomId].players); io.to(roomId).emit('sync_board', { action: data.action, tileIndex: data.tileIndex, playerId: p.id, playerName: p.username }); }
        }
    });

    socket.on('pay_rent', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const payer = getActor(room, socket.id, data.targetId); const payee = room.players.find(x => x.id === data.ownerId);
            if (payer && payee) { payer.score -= data.amount; payee.score += data.amount; io.to(roomId).emit('sync_players', room.players); io.to(roomId).emit('log_msg', `💸 <b>${payer.avatar} ${payer.username}</b> nộp ${data.amount}đ cho <b>${payee.username}</b>!`); }
        }
    });

    socket.on('next_turn', (targetId) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) { room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length; io.to(roomId).emit('turn_changed', room.currentTurnIdx); }
        }
    });

    socket.on('disconnect', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            let room = rooms[roomId]; const droppedName = room.players.find(p => p.id === socket.id)?.username || "Ai đó";
            room.players = room.players.filter(p => p.id !== socket.id);
            const realPlayers = room.players.filter(p => !p.isBot);
            if (realPlayers.length === 0) delete rooms[roomId];
            else {
                if (room.host === socket.id) { room.host = realPlayers[0].id; realPlayers[0].isReady = true; }
                if (room.isPlaying) {
                    if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
                    io.to(roomId).emit('player_dropped', { players: room.players, turn: room.currentTurnIdx }); io.to(roomId).emit('log_msg', `🔴 <b>${droppedName}</b> mất kết nối!`);
                } else io.to(roomId).emit('update_lobby', room);
            }
        }
        delete socketToRoom[socket.id];
    });
});

const PORT = process.env.PORT || 3000; server.listen(PORT, () => console.log(`🚀 Server EngQuest Online đang chạy tại cổng ${PORT}`));