const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const socketToRoom = {};

const AVATARS = ['🐶', '🐱', '🦊', '🐼', '🦁', '🐸', '🐯', '🐰'];

function generateRoomCode() {
    let code; do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]); return code;
}

function getActor(room, socketId, targetId) {
    if (targetId && targetId !== socketId && room.host === socketId) { return room.players.find(p => p.id === targetId && p.isBot); }
    return room.players.find(p => p.id === socketId);
}

function getAvailableAvatar(roomPlayers) {
    const used = roomPlayers.map(p => p.avatar);
    const available = AVATARS.filter(a => !used.includes(a));
    return available.length > 0 ? available[Math.floor(Math.random() * available.length)] : '👽';
}

function getStartingMoney(difficulty) {
    if (difficulty === 'medium') return 20000;
    if (difficulty === 'hard') return 30000;
    return 15000;
}

function checkBankrupt(roomId, p) {
    const room = rooms[roomId];
    if (p.score < 0 && !p.bankrupt) {
        p.bankrupt = true; p.score = "PHÁ SẢN";
        io.to(roomId).emit('log_msg', `☠️ <b>${p.username}</b> đã vỡ nợ và PHÁ SẢN! Toàn bộ đất đai bị tịch thu.`);
        io.to(roomId).emit('player_bankrupt', p.id);
        const alive = room.players.filter(pl => !pl.bankrupt);
        if (alive.length === 1) {
            io.to(roomId).emit('game_over', { winnerName: alive[0].username, winnerAvatar: alive[0].avatar, score: alive[0].score });
            room.isPlaying = false;
        }
    }
}

io.on('connection', (socket) => {
    socket.on('create_room', (pInfo) => {
        const roomId = generateRoomCode(); socket.join(roomId); socketToRoom[socket.id] = roomId;
        const startMoney = getStartingMoney(pInfo.difficulty || 'easy');
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: getAvailableAvatar([]), color: pInfo.color, isReady: true, score: startMoney, pos: 0, jail: false, bankrupt: false, qCount: 0, isBot: false };
        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer], isPlaying: false, currentTurnIdx: 0, stealData: null, difficulty: pInfo.difficulty || 'easy' };
        socket.emit('room_created', roomId); io.to(roomId).emit('update_lobby', rooms[roomId]);
    });

    socket.on('play_with_bot', (pInfo) => {
        const roomId = generateRoomCode(); socket.join(roomId); socketToRoom[socket.id] = roomId;
        const startMoney = getStartingMoney(pInfo.difficulty || 'easy');
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: getAvailableAvatar([]), color: pInfo.color, isReady: true, score: startMoney, pos: 0, jail: false, bankrupt: false, qCount: 0, isBot: false };
        const botPlayer = { id: 'bot_' + Math.random().toString(36).substr(2, 9), username: 'Máy (AI)', avatar: getAvailableAvatar([newPlayer]), color: '#00cec9', isReady: true, score: startMoney, pos: 0, jail: false, bankrupt: false, qCount: 0, isBot: true };
        rooms[roomId] = { id: roomId, host: socket.id, players: [newPlayer, botPlayer], isPlaying: true, currentTurnIdx: 0, stealData: null, difficulty: pInfo.difficulty || 'easy', gameStartTime: Date.now() };
        socket.emit('room_created', roomId); io.to(roomId).emit('update_lobby', rooms[roomId]); io.to(roomId).emit('game_started', rooms[roomId]);
    });

    socket.on('join_room', (data) => {
        const { roomId, pInfo } = data; const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', "Mã phòng không tồn tại!");
        if (room.isPlaying) return socket.emit('error_msg', "Phòng đang chơi rồi!");
        if (room.players.length >= 4) return socket.emit('error_msg', "Phòng đã đầy!");
        socket.join(roomId); socketToRoom[socket.id] = roomId;
        const startMoney = getStartingMoney(room.difficulty);
        const newPlayer = { id: socket.id, username: pInfo.username, avatar: getAvailableAvatar(room.players), color: pInfo.color, isReady: false, score: startMoney, pos: 0, jail: false, bankrupt: false, qCount: 0, isBot: false };
        room.players.push(newPlayer); io.to(roomId).emit('update_lobby', room);
    });

    socket.on('send_chat', (msg) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const p = rooms[roomId].players.find(x => x.id === socket.id);
            if (p) io.to(roomId).emit('receive_chat', { sender: p.username, avatar: p.avatar, color: p.color, text: msg });
        }
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
            room.isPlaying = true; room.gameStartTime = Date.now(); io.to(roomId).emit('game_started', room);
        }
    });

    socket.on('request_roll', (targetId) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) {
                let v1 = Math.floor(Math.random() * 6) + 1; let v2 = Math.floor(Math.random() * 6) + 1; let total = v1 + v2;
                if (actor.jail) {
                    if (v1 === v2 || Math.random() < 0.3) {
                        actor.jail = false; io.to(roomId).emit('sync_players', room.players);
                        io.to(roomId).emit('jail_escaped', { v1, v2, total, playerId: actor.id });
                    } else {
                        io.to(roomId).emit('dice_rolled', { v1, v2, total, playerId: actor.id, remainInJail: true });
                    }
                } else {
                    io.to(roomId).emit('dice_rolled', { v1, v2, total, playerId: actor.id });
                }
            }
        }
    });

    socket.on('movement_complete', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId); const finalPos = data.pos;
            if (p) {
                if (p.pos > finalPos && finalPos < 12) { p.score += 2000; io.to(roomId).emit('log_msg', `✅ <b>${p.avatar} ${p.username}</b> qua cờ GO (+2000đ)`); }
                p.pos = finalPos; io.to(roomId).emit('sync_players', room.players);
            }
        }
    });

    socket.on('player_jailed', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const p = getActor(rooms[roomId], socket.id, data.targetId);
            if (p) { p.jail = true; p.pos = 8; io.to(roomId).emit('sync_players', rooms[roomId].players); }
        }
    });

    socket.on('force_move', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const p = getActor(rooms[roomId], socket.id, data.targetId);
            if (p) {
                p.pos = data.pos;
                if (data.pos === 0) { p.score += 2000; io.to(roomId).emit('log_msg', `🎉 <b>${p.avatar} ${p.username}</b> được thưởng 2000đ khi bay về GO!`); }
                io.to(roomId).emit('sync_players', rooms[roomId].players);
            }
        }
    });

    socket.on('share_question', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId) socket.to(roomId).emit('show_shared_question', data);
    });

    socket.on('answered_result', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const p = getActor(room, socket.id, data.targetId);
            if (p) {
                io.to(roomId).emit('hide_spectator');
                if (data.isStealAnswer) { handleStealAnswer(roomId, p, data.correct, data.points); return; }
                if (!data.isBonus) p.qCount++;

                if (data.correct || data.isBonus) {
                    p.score += data.points;
                    io.to(roomId).emit('log_msg', `${data.correct ? '✅' : '🍀'} <b>${p.avatar} ${p.username}</b> ${data.isBonus ? 'rút thẻ' : 'trả lời ĐÚNG'} và nhận được <b>${data.points}đ</b>!`);
                    io.to(roomId).emit('sync_players', room.players);
                    if (data.isBonus) { setTimeout(() => { io.to(roomId).emit('resume_original_turn'); }, 1500); }
                    else { socket.emit('process_property_action', { tileIndex: data.tileIndex, playerId: p.id }); }
                } else {
                    if (data.isBonus) {
                        p.score += data.points; io.to(roomId).emit('log_msg', `❌ <b>${p.avatar} ${p.username}</b> bị trừ ${Math.abs(data.points)}đ!`);
                        io.to(roomId).emit('sync_players', room.players); checkBankrupt(roomId, p);
                        setTimeout(() => { io.to(roomId).emit('resume_original_turn'); }, 1500); return;
                    }
                    io.to(roomId).emit('log_msg', `❌ <b>${p.avatar} ${p.username}</b> trả lời SAI! Cơ hội cướp điểm bắt đầu!`);
                    io.to(roomId).emit('sync_players', room.players);

                    const activePlayers = room.players.filter(pl => !pl.bankrupt && !pl.jail);
                    if (activePlayers.length > 1) {
                        const targetTime = (Math.random() * 4 + 3).toFixed(2);
                        room.stealData = { originalPlayerId: p.id, targetTime: parseFloat(targetTime), submissions: [], tileIndex: data.tileIndex, questionData: data.questionData };
                        io.to(roomId).emit('start_steal_clock', { targetTime, originalPlayerId: p.id, questionData: data.questionData });

                        const botInRoom = activePlayers.find(pl => pl.isBot);
                        if (botInRoom && botInRoom.id !== p.id) {
                            const botStopTime = parseFloat(targetTime) + (Math.random() * 1.5 - 0.75);
                            setTimeout(() => {
                                if (rooms[roomId] && rooms[roomId].stealData) {
                                    rooms[roomId].stealData.submissions.push({ pId: botInRoom.id, stoppedAt: botStopTime });
                                    if (rooms[roomId].stealData.submissions.length >= activePlayers.length - 1) evaluateStealGame(roomId);
                                }
                            }, botStopTime * 1000);
                        }
                        setTimeout(() => { evaluateStealGame(roomId); }, 10000);
                    } else {
                        io.to(roomId).emit('log_msg', `🕰️ Các đối thủ đang bận/ở tù, không ai cướp điểm!`); io.to(roomId).emit('resume_original_turn');
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
            const activeCount = room.players.filter(pl => !pl.bankrupt && !pl.jail).length;
            if (room.stealData.submissions.length >= activeCount - 1) { evaluateStealGame(roomId); }
        }
    });

    function evaluateStealGame(roomId) {
        const room = rooms[roomId]; if (!room || !room.stealData) return;
        const sd = room.stealData; room.stealData = null;

        if (sd.submissions.length === 0) { io.to(roomId).emit('log_msg', `🕰️ Hết giờ! Không ai dám cướp câu này.`); io.to(roomId).emit('resume_original_turn'); return; }

        let winner = null; let minDiff = 9999;
        sd.submissions.forEach(sub => { const diff = Math.abs(sub.stoppedAt - sd.targetTime); if (diff < minDiff) { minDiff = diff; winner = sub.pId; } });
        const pWinner = room.players.find(p => p.id === winner);
        io.to(roomId).emit('log_msg', `⏱️ <b>${pWinner.username}</b> bấm chuẩn nhất (Sai số: ${minDiff.toFixed(2)}s) và giành quyền CƯỚP!`);
        io.to(roomId).emit('steal_winner_selected', { winnerId: winner, questionData: sd.questionData });

        if (pWinner.isBot) {
            setTimeout(() => {
                if (rooms[roomId]) { let pts = room.difficulty === 'easy' ? 500 : (room.difficulty === 'medium' ? 1000 : 2000); handleStealAnswer(roomId, pWinner, Math.random() < 0.75, pts); }
            }, 2500);
        }
    }

    function handleStealAnswer(roomId, p, isCor, points) {
        const room = rooms[roomId];
        if (isCor) { p.score += points; io.to(roomId).emit('log_msg', `🔥 <b>${p.avatar} ${p.username}</b> cướp thành công nhận ${points}đ!`); }
        else { io.to(roomId).emit('log_msg', `❌ <b>${p.avatar} ${p.username}</b> cướp hụt rồi!`); }
        io.to(roomId).emit('sync_players', room.players); io.to(roomId).emit('resume_original_turn');
    }

    socket.on('property_action', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const p = getActor(room, socket.id, data.targetId);
            if (p) {
                p.score -= parseInt(data.cost); io.to(roomId).emit('sync_players', room.players); io.to(roomId).emit('sync_board', { action: data.action, tileIndex: data.tileIndex, playerId: p.id });
                io.to(roomId).emit('log_msg', `🏢 <b>${p.avatar} ${p.username}</b> vừa ${data.action === 'buy' ? 'mua' : 'nâng cấp'} <b>${data.tileName}</b> với giá <b>${data.cost}đ</b>!`);
                checkBankrupt(roomId, p);
            }
        }
    });

    socket.on('pay_rent', (data) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId]; const payer = getActor(room, socket.id, data.targetId); const payee = room.players.find(x => x.id === data.ownerId);
            if (payer && payee && !payee.bankrupt) {
                payer.score -= data.amount; payee.score += data.amount; io.to(roomId).emit('sync_players', room.players);
                io.to(roomId).emit('log_msg', `💸 <b>${payer.avatar} ${payer.username}</b> nộp ${data.amount}đ cho <b>${payee.username}</b>!`); checkBankrupt(roomId, payer);
            }
        }
    });

    socket.on('next_turn', (targetId) => {
        const roomId = socketToRoom[socket.id]; if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const actor = getActor(room, socket.id, targetId);
            if (actor && room.players[room.currentTurnIdx]?.id === actor.id) {
                do { room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length; } while (room.players[room.currentTurnIdx].bankrupt);
                io.to(roomId).emit('turn_changed', room.currentTurnIdx);
            }
        }
    });

    socket.on('force_next_turn', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId] && rooms[roomId].host === socket.id) {
            const room = rooms[roomId]; do { room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length; } while (room.players[room.currentTurnIdx].bankrupt);
            io.to(roomId).emit('turn_changed', room.currentTurnIdx); io.to(roomId).emit('log_msg', `⚙️ Chủ phòng đã sử dụng quyền Ép chuyển lượt!`);
        }
    });

    socket.on('disconnect', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            let room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.filter(p => !p.isBot).length === 0) delete rooms[roomId];
            else {
                if (room.host === socket.id) { room.host = room.players.filter(p => !p.isBot)[0].id; room.players.find(p => p.id === room.host).isReady = true; }
                if (room.isPlaying) { if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0; io.to(roomId).emit('player_dropped', { players: room.players, turn: room.currentTurnIdx }); }
                else io.to(roomId).emit('update_lobby', room);
            }
        }
        delete socketToRoom[socket.id];
    });
});

const PORT = process.env.PORT || 3000; server.listen(PORT, () => console.log(`🚀 Server EngQuest FULL đang chạy tại cổng ${PORT}`));