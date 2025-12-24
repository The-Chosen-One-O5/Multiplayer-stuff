import type { PartyKitServer, PartyKitRoom } from "partykit/server";

type Player = {
  id: string;
  x: number;
  z: number;
  rot: number;
  role: "hunter" | "runner";
  hp: number;
  weapon: string;
  charIndex: number;
};

type Minion = {
  x: number;
  z: number;
  hp: number;
};

type GameState = {
  players: Record<string, Player>;
  minion: Minion | null;
  started: boolean;
  lastHitTime: number;
};

function checkWinCondition(room: PartyKitRoom, state: GameState) {
  const aliveRunners = Object.values(state.players).filter((p) => p.role === "runner" && p.hp > 0).length;
  const aliveHunter = Object.values(state.players).find((p) => p.role === "hunter" && p.hp > 0);
  const minionAlive = state.minion && state.minion.hp > 0;

  if (aliveRunners === 0) {
    room.broadcast(JSON.stringify({ type: "game-over", winner: "Hunter", reason: "Runners Eliminated" }));
  } else if (!aliveHunter && !minionAlive) {
    room.broadcast(JSON.stringify({ type: "game-over", winner: "Runners", reason: "Hunter & Minion Defeated" }));
  }
}

export default {
  onConnect(conn, room) {
    console.log(`Connected: ${conn.id}`);
    
    const state = room.getState() as GameState | null;
    if (state) {
      conn.send(JSON.stringify({ type: "init", state }));
    }
  },

  onMessage(message, conn, room) {
    const data = JSON.parse(message as string);
    let state = room.getState() as GameState;

    if (!state) {
      state = {
        players: {},
        minion: null,
        started: false,
        lastHitTime: 0
      };
      room.setState(state);
    }

    switch (data.type) {
      case "join": {
        // New player joining
        state.players[conn.id] = {
          id: conn.id,
          x: 0,
          z: 0,
          rot: 0,
          role: "runner",
          hp: 100,
          weapon: "none",
          charIndex: 0
        };
        
        // Broadcast updated player list
        room.broadcast(JSON.stringify({
          type: "player-join",
          players: Object.values(state.players).map(p => ({
            id: p.id,
            charIndex: p.charIndex,
            hp: p.hp,
            role: p.role
          }))
        }));
        
        // Send init to new player
        conn.send(JSON.stringify({ type: "init", state }));
        break;
      }

      case "select-char": {
        if (state.players[conn.id]) {
          state.players[conn.id].charIndex = data.charIndex;
          room.broadcast(JSON.stringify({
            type: "player-update",
            player: state.players[conn.id]
          }));
        }
        break;
      }

      case "move":
        if (state.players[data.id]) {
          state.players[data.id].x = data.x;
          state.players[data.id].z = data.z;
          state.players[data.id].rot = data.rot;
          room.broadcast(JSON.stringify({
            type: "update",
            id: data.id,
            pos: { x: data.x, z: data.z },
            rot: data.rot
          }), [conn.id]);
        }
        break;

      case "start-game": {
        const playerIds = Object.keys(state.players);
        if (playerIds.length === 0) break;
        
        const hunterId = playerIds[Math.floor(Math.random() * playerIds.length)];
        
        Object.keys(state.players).forEach(id => {
          state.players[id].role = (id === hunterId) ? "hunter" : "runner";
          state.players[id].hp = 100;
          state.players[id].weapon = "none";
        });

        state.minion = { x: 0, z: 0, hp: 500 };
        state.started = true;

        room.broadcast(JSON.stringify({ type: "game-start", state }));
        break;
      }

      case "hit": {
        const target = state.players[data.targetId];
        if (target) {
          target.hp -= data.damage;
          if (target.hp < 0) target.hp = 0;

          if (target.hp === 0 && data.sourceId) {
             const source = state.players[data.sourceId];
             if (source && source.role === "hunter") {
               source.hp = Math.min(150, source.hp + 20);
             }
          }

          room.broadcast(JSON.stringify({ 
            type: "hit", 
            targetId: data.targetId, 
            hp: target.hp 
          }));

          checkWinCondition(room, state);
        }
        break;
      }

      case "minion-hit": {
        if(state.minion) {
          state.minion.hp -= data.damage;
          room.broadcast(JSON.stringify({ type: "minion-hit", hp: state.minion.hp }));
          if(state.minion.hp <= 0) {
            state.minion = null;
            checkWinCondition(room, state);
          }
        }
        break;
      }

      case "pickup": {
        if (state.players[data.id]) {
          state.players[data.id].weapon = data.weapon;
          room.broadcast(JSON.stringify({
            type: "pickup",
            id: data.id,
            weapon: data.weapon
          }));
        }
        break;
      }
    }
  },

  onStart(room) {
    // Server-side Game Loop for Minion AI (Runs every 50ms)
    const minionInterval = setInterval(() => {
      const state = room.getState() as GameState;
      if (!state?.started || !state.minion) return;

      // Find nearest runner
      let nearest: Player | null = null;
      let minDist = 9999;
      
      Object.values(state.players).forEach((p) => {
        if (p.role === 'runner' && p.hp > 0) {
          const d = Math.hypot(p.x - state.minion!.x, p.z - state.minion!.z);
          if (d < minDist) { minDist = d; nearest = p; }
        }
      });

      if (nearest) {
        const dx = nearest.x - state.minion.x;
        const dz = nearest.z - state.minion.z;
        const len = Math.sqrt(dx*dx + dz*dz);
        
        if (len > 0) {
          const speed = 0.15;
          state.minion.x += (dx / len) * speed;
          state.minion.z += (dz / len) * speed;
          
          if (minDist < 3.5) {
            nearest.hp -= 0.5;
            if (nearest.hp < 0) nearest.hp = 0;
            
            room.broadcast(JSON.stringify({
              type: "hit",
              targetId: nearest.id,
              hp: nearest.hp
            }));
            checkWinCondition(room, state);
          }
        }
      }

      room.broadcast(JSON.stringify({
        type: "minion-update",
        x: state.minion.x,
        z: state.minion.z,
        hp: state.minion.hp
      }));

    }, 50);

    // Cleanup on room close
    room.onClose(() => {
      clearInterval(minionInterval);
    });
  }
} satisfies PartyKitServer;
