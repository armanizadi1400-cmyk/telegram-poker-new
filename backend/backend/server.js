const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TABLE_COUNT = 6;
const MAX_PLAYERS = 6;
const BOTS_PER_TABLE = 3;
const STARTING_CHIPS = 1000;
const TURN_SECONDS = 20;

const tables = [];

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [
  "2", "3", "4", "5", "6", "7",
  "8", "9", "10", "J", "Q", "K", "A"
];

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        rank,
        suit
      });
    }
  }

  return shuffle(deck);
}

function shuffle(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function createPlayer(id, name, isBot = false) {
  return {
    id,
    name,
    isBot,
    chips: STARTING_CHIPS,
    cards: [],
    folded: false,
    allIn: false,
    currentBet: 0,
    totalBet: 0
  };
}

function createTable(id) {
  return {
    id,
    players: [],
    waiting: [],

    deck: [],
    communityCards: [],

    pot: 0,

    stage: "waiting",
    started: false,

    dealerIndex: 0,
    currentPlayerIndex: 0,

    currentBet: 0,
    minimumRaise: 20,

    actedPlayers: [],

    turnStartedAt: null,

    handNumber: 0,

    winner: null,
    message: "Waiting for players"
  };
}

for (let i = 1; i <= TABLE_COUNT; i++) {
  tables.push(createTable(i));
}

function getTable(id) {
  return tables.find(table => table.id === Number(id));
}

function activePlayers(table) {
  return table.players.filter(
    player => !player.folded && !player.allIn
  );
}

function playersInHand(table) {
  return table.players.filter(player => !player.folded);
}

function broadcastTable(table) {
  const data = JSON.stringify({
    type: "table_update",
    table: serializeTable(table)
  });

  wss.clients.forEach(client => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.tableId === table.id
    ) {
      client.send(data);
    }
  });
}

function serializeTable(table) {
  return {
    id: table.id,

    stage: table.stage,

    started: table.started,

    pot: table.pot,

    currentBet: table.currentBet,

    minimumRaise: table.minimumRaise,

    currentPlayer:
      table.players[table.currentPlayerIndex]?.id || null,

    currentPlayerName:
      table.players[table.currentPlayerIndex]?.name || null,

    turnStartedAt: table.turnStartedAt,

    turnSeconds: TURN_SECONDS,

    communityCards: table.communityCards,

    winner: table.winner,

    message: table.message,

    players: table.players.map(player => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
      chips: player.chips,
      folded: player.folded,
      allIn: player.allIn,
      currentBet: player.currentBet,

      cards: player.cards,

      isTurn:
        table.started &&
        table.players[table.currentPlayerIndex]?.id === player.id
    })),

    waiting: table.waiting.map(player => ({
      id: player.id,
      name: player.name
    }))
  };
}

function addBots(table) {
  let botNumber = 1;

  while (
    table.players.filter(player => player.isBot).length <
      BOTS_PER_TABLE &&
    table.players.length < MAX_PLAYERS
  ) {
    const botId = `bot_${table.id}_${botNumber}_${Date.now()}`;

    const bot = createPlayer(
      botId,
      `Player ${botNumber}`,
      true
    );

    table.players.push(bot);

    botNumber++;
  }
}

function nextPlayerIndex(table, startIndex) {
  if (table.players.length === 0) {
    return -1;
  }

  for (
    let i = 1;
    i <= table.players.length;
    i++
  ) {
    const index =
      (startIndex + i) % table.players.length;

    const player = table.players[index];

    if (
      !player.folded &&
      !player.allIn
    ) {
      return index;
    }
  }

  return -1;
}

function resetPlayerForHand(player) {
  player.cards = [];
  player.folded = false;
  player.allIn = false;
  player.currentBet = 0;
  player.totalBet = 0;
}

function dealHoleCards(table) {
  for (const player of table.players) {
    player.cards = [];
  }

  for (let round = 0; round < 2; round++) {
    for (const player of table.players) {
      const card = table.deck.pop();

      if (card) {
        player.cards.push(card);
      }
    }
  }
}

function startHand(table) {
  if (table.players.length < 2) {
    table.message = "Need at least 2 players";
    return false;
  }

  table.deck = createDeck();
  table.communityCards = [];

  table.pot = 0;

  table.stage = "preflop";
  table.started = true;

  table.currentBet = 0;
  table.minimumRaise = 20;

  table.actedPlayers = [];

  table.handNumber++;

  table.winner = null;

  for (const player of table.players) {
    resetPlayerForHand(player);
  }

  dealHoleCards(table);

  const dealer = table.players[table.dealerIndex];

  if (dealer) {
    const smallBlindIndex =
      (table.dealerIndex + 1) %
      table.players.length;

    const bigBlindIndex =
      (table.dealerIndex + 2) %
      table.players.length;

    const smallBlind =
      table.players[smallBlindIndex];

    const bigBlind =
      table.players[bigBlindIndex];

    const sb = Math.min(10, smallBlind.chips);
    const bb = Math.min(20, bigBlind.chips);

    smallBlind.chips -= sb;
    smallBlind.currentBet += sb;
    smallBlind.totalBet += sb;

    bigBlind.chips -= bb;
    bigBlind.currentBet += bb;
    bigBlind.totalBet += bb;

    table.pot += sb + bb;

    table.currentBet = bb;

    table.currentPlayerIndex =
      (bigBlindIndex + 1) %
      table.players.length;
  }

  table.turnStartedAt = Date.now();

  table.message = "Preflop";

  return true;
}

function allActivePlayersAllIn(table) {
  const players = playersInHand(table);

  if (players.length <= 1) {
    return true;
  }

  return players.every(
    player => player.allIn
  );
}

function burnCard(table) {
  if (table.deck.length > 0) {
    table.deck.pop();
  }
}

function dealFlop(table) {
  burnCard(table);

  for (let i = 0; i < 3; i++) {
    const card = table.deck.pop();

    if (card) {
      table.communityCards.push(card);
    }
  }

  table.stage = "flop";
}

function dealTurn(table) {
  burnCard(table);

  const card = table.deck.pop();

  if (card) {
    table.communityCards.push(card);
  }

  table.stage = "turn";
}

function dealRiver(table) {
  burnCard(table);

  const card = table.deck.pop();

  if (card) {
    table.communityCards.push(card);
  }

  table.stage = "river";
}

function resetStreet(table) {
  table.currentBet = 0;
  table.minimumRaise = 20;
  table.actedPlayers = [];

  for (const player of table.players) {
    player.currentBet = 0;
  }
}

function advanceStreet(table) {
  if (table.stage === "preflop") {
    dealFlop(table);
    resetStreet(table);
  }

  else if (table.stage === "flop") {
    dealTurn(table);
    resetStreet(table);
  }

  else if (table.stage === "turn") {
    dealRiver(table);
    resetStreet(table);
  }

  else if (table.stage === "river") {
    finishHand(table);
    return;
  }

  else {
    return;
  }

  const next =
    nextPlayerIndex(
      table,
      table.dealerIndex
    );

  table.currentPlayerIndex =
    next === -1 ? 0 : next;

  table.turnStartedAt = Date.now();

  table.message =
    table.stage.toUpperCase();
}

function playerCanAct(table, player) {
  if (!table.started) return false;

  if (!player) return false;

  const current =
    table.players[
      table.currentPlayerIndex
    ];

  return current &&
    current.id === player.id &&
    !player.folded &&
    !player.allIn;
}

function performAction(
  table,
  playerId,
  action,
  amount = 0
) {
  const player =
    table.players.find(
      p => p.id === playerId
    );

  if (!player) {
    return {
      success: false,
      error: "Player not found"
    };
  }

  if (!playerCanAct(table, player)) {
    return {
      success: false,
      error: "Not your turn"
    };
  }

  if (action === "fold") {
    player.folded = true;
  }

  else if (action === "check") {
    if (
      player.currentBet !==
      table.currentBet
    ) {
      return {
        success: false,
        error: "Cannot check"
      };
    }
  }

  else if (action === "call") {
    const needed =
      table.currentBet -
      player.currentBet;

    const callAmount =
      Math.min(
        needed,
        player.chips
      );

    player.chips -= callAmount;

    player.currentBet += callAmount;
    player.totalBet += callAmount;

    table.pot += callAmount;

    if (player.chips === 0) {
      player.allIn = true;
    }
  }

  else if (action === "raise") {
    const raiseTo =
      Number(amount);

    if (
      !Number.isFinite(raiseTo) ||
      raiseTo <= table.currentBet
    ) {
      return {
        success: false,
        error: "Invalid raise"
      };
    }

    const required =
      raiseTo -
      player.currentBet;

    if (required > player.chips) {
      return {
        success: false,
        error: "Not enough chips"
      };
    }

    player.chips -= required;

    player.currentBet += required;
    player.totalBet += required;

    table.pot += required;

    table.minimumRaise =
      raiseTo -
      table.currentBet;

    table.currentBet =
      raiseTo;

    if (player.chips === 0) {
      player.allIn = true;
    }
  }

  else if (action === "allin") {
    const amount =
      player.chips;

    player.chips = 0;

    player.currentBet += amount;
    player.totalBet += amount;

    table.pot += amount;

    if (
      player.currentBet >
      table.currentBet
    ) {
      table.currentBet =
        player.currentBet;
    }

    player.allIn = true;
  }

  else {
    return {
      success: false,
      error: "Unknown action"
    };
  }

  if (
    !table.actedPlayers.includes(
      player.id
    )
  ) {
    table.actedPlayers.push(
      player.id
    );
  }

  if (
    playersInHand(table).length === 1
  ) {
    finishHand(table);
    return {
      success: true
    };
  }

  if (allActivePlayersAllIn(table)) {
    while (
      table.stage !== "river" &&
      table.started
    ) {
      if (table.stage === "preflop") {
        dealFlop(table);
      }

      else if (table.stage === "flop") {
        dealTurn(table);
      }

      else if (table.stage === "turn") {
        dealRiver(table);
      }

      resetStreet(table);
    }

    finishHand(table);

    return {
      success: true
    };
  }

  const active =
    activePlayers(table);

  const allActed =
    active.length > 0 &&
    active.every(
      p =>
        table.actedPlayers.includes(
          p.id
        ) &&
        p.currentBet ===
          table.currentBet
    );

  if (allActed) {
    advanceStreet(table);

    return {
      success: true
    };
  }

  const next =
    nextPlayerIndex(
      table,
      table.currentPlayerIndex
    );

  if (next !== -1) {
    table.currentPlayerIndex =
      next;

    table.turnStartedAt =
      Date.now();
  }

  broadcastTable(table);

  return {
    success: true
  };
}

function finishHand(table) {
  const remaining =
    playersInHand(table);

  if (remaining.length === 1) {
    const winner =
      remaining[0];

    winner.chips += table.pot;

    table.winner = {
      id: winner.id,
      name: winner.name,
      amount: table.pot
    };

    table.message =
      `${winner.name} wins ${table.pot}`;

    table.pot = 0;
  }

  else if (remaining.length > 1) {
    const winner =
      remaining[
        Math.floor(
          Math.random() *
          remaining.length
        )
      ];

    winner.chips += table.pot;

    table.winner = {
      id: winner.id,
      name: winner.name,
      amount: table.pot
    };

    table.message =
      `${winner.name} wins ${table.pot}`;

    table.pot = 0;
  }

  table.started = false;
  table.stage = "finished";

  table.turnStartedAt = null;

  table.dealerIndex =
    (table.dealerIndex + 1) %
    Math.max(1, table.players.length);

  moveWaitingPlayers(table);

  setTimeout(() => {
    if (
      table.players.length >= 2 &&
      !table.started
    ) {
      startHand(table);
      broadcastTable(table);
    }
  }, 3000);
}

function moveWaitingPlayers(table) {
  while (
    table.waiting.length > 0 &&
    table.players.length < MAX_PLAYERS
  ) {
    const player =
      table.waiting.shift();

    table.players.push(player);
  }
}

function botAction(table) {
  if (!table.started) return;

  const player =
    table.players[
      table.currentPlayerIndex
    ];

  if (!player || !player.isBot) {
    return;
  }

  setTimeout(() => {
    if (!table.started) return;

    const current =
      table.players[
        table.currentPlayerIndex
      ];

    if (
      !current ||
      current.id !== player.id
    ) {
      return;
    }

    const needed =
      table.currentBet -
      player.currentBet;

    let action = "check";
    let amount = 0;

    const random =
      Math.random();

    if (needed > 0) {
      if (random < 0.10) {
        action = "fold";
      }

      else if (random < 0.80) {
        action = "call";
      }

      else {
        action = "raise";

        amount =
          table.currentBet + 20;
      }
    }

    else {
      if (random < 0.70) {
        action = "check";
      }

      else {
        action = "raise";

        amount =
          table.currentBet + 20;
      }
    }

    performAction(
      table,
      player.id,
      action,
      amount
    );

    broadcastTable(table);
  }, 1200 + Math.random() * 1800);
}

function checkTurnTimers() {
  for (const table of tables) {
    if (!table.started) continue;

    const current =
      table.players[
        table.currentPlayerIndex
      ];

    if (!current) continue;

    if (current.isBot) {
      botAction(table);
      continue;
    }

    if (!table.turnStartedAt) {
      table.turnStartedAt =
        Date.now();

      continue;
    }

    const elapsed =
      Date.now() -
      table.turnStartedAt;

    if (
      elapsed >=
      TURN_SECONDS * 1000
    ) {
      performAction(
        table,
        current.id,
        "fold"
      );

      table.message =
        `${current.name} timed out`;

      broadcastTable(table);
    }
  }
}

setInterval(
  checkTurnTimers,
  500
);

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Telegram Poker Backend",
    tables: TABLE_COUNT
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/tables", (req, res) => {
  res.json({
    success: true,

    tables: tables.map(table => ({
      id: table.id,
      players: table.players.length,
      maxPlayers: MAX_PLAYERS,
      started: table.started,
      stage: table.stage
    }))
  });
});

app.get("/game/:tableId", (req, res) => {
  const table =
    getTable(req.params.tableId);

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  res.json({
    success: true,
    table: serializeTable(table)
  });
});

app.get("/my-cards/:tableId/:playerId", (req, res) => {
  const table =
    getTable(req.params.tableId);

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  const player =
    table.players.find(
      p =>
        p.id ===
        req.params.playerId
    );

  if (!player) {
    return res.status(404).json({
      success: false,
      error: "Player not found"
    });
  }

  res.json({
    success: true,
    cards: player.cards
  });
});

app.post("/join", (req, res) => {
  const {
    tableId,
    playerId,
    name
  } = req.body;

  const table =
    getTable(tableId);

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  const existing =
    tables
      .flatMap(t => t.players)
      .find(p => p.id === playerId);

  if (existing) {
    return res.json({
      success: true,
      message: "Already joined",
      playerId: existing.id,
      tableId
    });
  }

  const player =
    createPlayer(
      String(playerId),
      name || "Player",
      false
    );

  if (
    table.started ||
    table.players.length >= MAX_PLAYERS
  ) {
    table.waiting.push(player);

    return res.json({
      success: true,
      waiting: true,
      message:
        "You will join after this hand",
      tableId
    });
  }

  table.players.push(player);

  addBots(table);

  if (
    table.players.length >=
    2 &&
    !table.started
  ) {
    startHand(table);
  }

  broadcastTable(table);

  res.json({
    success: true,
    waiting: false,
    playerId: player.id,
    tableId
  });
});

app.post("/leave", (req, res) => {
  const {
    tableId,
    playerId
  } = req.body;

  const table =
    getTable(tableId);

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  table.players =
    table.players.filter(
      p => p.id !== playerId
    );

  table.waiting =
    table.waiting.filter(
      p => p.id !== playerId
    );

  if (
    table.players.length < 2 &&
    table.started
  ) {
    finishHand(table);
  }

  broadcastTable(table);

  res.json({
    success: true
  });
});

app.post("/action", (req, res) => {
  const {
    tableId,
    playerId,
    action,
    amount
  } = req.body;

  const table =
    getTable(tableId);

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  const result =
    performAction(
      table,
      String(playerId),
      action,
      Number(amount || 0)
    );

  broadcastTable(table);

  res.json(result);
});

app.post("/reset", (req, res) => {
  for (const table of tables) {
    table.players = [];
    table.waiting = [];
    table.deck = [];
    table.communityCards = [];
    table.pot = 0;
    table.stage = "waiting";
    table.started = false;
    table.currentBet = 0;
    table.actedPlayers = [];
    table.winner = null;
    table.message = "Waiting for players";
  }

  res.json({
    success: true
  });
});

wss.on("connection", ws => {
  ws.on("message", message => {
    try {
      const data =
        JSON.parse(message.toString());

      if (
        data.type ===
        "join_table"
      ) {
        ws.tableId =
          Number(data.tableId);

        const table =
          getTable(ws.tableId);

        if (table) {
          ws.send(
            JSON.stringify({
              type: "table_update",
              table:
                serializeTable(table)
            })
          );
        }
      }
    }

    catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          message:
            "Invalid message"
        })
      );
    }
  });
});

server.listen(
  PORT,
  () => {
    console.log(
      `Poker server running on port ${PORT}`
    );
  }
);
