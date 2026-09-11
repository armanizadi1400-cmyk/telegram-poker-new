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
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_SECONDS = 20;

const RANKS = [
  "2", "3", "4", "5", "6", "7",
  "8", "9", "T", "J", "Q", "K", "A"
];

const SUITS = ["♠", "♥", "♦", "♣"];

const tables = [];

function createDeck() {
  const deck = [];

  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(`${rank}${suit}`);
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
    bet: 0,
    totalBet: 0,
    acted: false
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
    currentBet: 0,
    minimumRaise: BIG_BLIND,

    stage: "waiting",
    dealerIndex: 0,
    currentPlayerIndex: -1,

    handNumber: 0,
    turnStartedAt: null,

    started: false,
    winner: null,
    message: ""
  };
}

for (let i = 1; i <= TABLE_COUNT; i++) {
  tables.push(createTable(i));
}

function activePlayers(table) {
  return table.players.filter(p => !p.folded);
}

function playersAbleToAct(table) {
  return table.players.filter(
    p => !p.folded && !p.allIn && p.chips > 0
  );
}

function getCurrentPlayer(table) {
  if (
    table.currentPlayerIndex < 0 ||
    table.currentPlayerIndex >= table.players.length
  ) {
    return null;
  }

  return table.players[table.currentPlayerIndex];
}

function nextPlayerIndex(table, startIndex) {
  if (table.players.length === 0) return -1;

  for (let i = 1; i <= table.players.length; i++) {
    const index =
      (startIndex + i) % table.players.length;

    const player = table.players[index];

    if (
      !player.folded &&
      !player.allIn &&
      player.chips > 0
    ) {
      return index;
    }
  }

  return -1;
}

function resetPlayersForHand(table) {
  for (const player of table.players) {
    player.cards = [];
    player.folded = false;
    player.allIn = false;
    player.bet = 0;
    player.totalBet = 0;
    player.acted = false;
  }
}

function collectBets(table) {
  for (const player of table.players) {
    table.pot += player.bet;
    player.totalBet += player.bet;
    player.bet = 0;
  }
}

function payPlayer(player, amount) {
  const actual = Math.min(player.chips, amount);

  player.chips -= actual;

  if (player.chips === 0) {
    player.allIn = true;
  }

  return actual;
}

function placeBet(player, amount) {
  const actual = payPlayer(player, amount);
  player.bet += actual;

  return actual;
}

function dealHoleCards(table) {
  for (let round = 0; round < 2; round++) {
    for (const player of table.players) {
      player.cards.push(table.deck.pop());
    }
  }
}

function dealFlop(table) {
  table.deck.pop();

  table.communityCards.push(table.deck.pop());
  table.communityCards.push(table.deck.pop());
  table.communityCards.push(table.deck.pop());
}

function dealTurn(table) {
  table.deck.pop();
  table.communityCards.push(table.deck.pop());
}

function dealRiver(table) {
  table.deck.pop();
  table.communityCards.push(table.deck.pop());
}

function setNextTurn(table) {
  const current = table.currentPlayerIndex;

  const next = nextPlayerIndex(table, current);

  table.currentPlayerIndex = next;

  if (next >= 0) {
    table.turnStartedAt = Date.now();
  } else {
    table.turnStartedAt = null;
  }
}

function everyoneActed(table) {
  const active = playersAbleToAct(table);

  if (active.length === 0) return true;

  return active.every(
    p => p.acted && p.bet === table.currentBet
  );
}

function startBettingRound(table, firstIndex) {
  for (const player of table.players) {
    if (!player.folded && !player.allIn) {
      player.acted = false;
    }
  }

  table.currentPlayerIndex = firstIndex;

  if (firstIndex >= 0) {
    table.turnStartedAt = Date.now();
  }
}

function startHand(table) {
  if (table.players.length < 2) {
    table.started = false;
    table.stage = "waiting";
    return;
  }

  resetPlayersForHand(table);

  table.deck = createDeck();
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = BIG_BLIND;
  table.minimumRaise = BIG_BLIND;
  table.stage = "preflop";
  table.started = true;
  table.winner = null;
  table.message = "";
  table.handNumber++;

  dealHoleCards(table);

  const dealer = table.dealerIndex % table.players.length;

  const smallBlindIndex =
    (dealer + 1) % table.players.length;

  const bigBlindIndex =
    (dealer + 2) % table.players.length;

  placeBet(table.players[smallBlindIndex], SMALL_BLIND);
  placeBet(table.players[bigBlindIndex], BIG_BLIND);

  table.players[smallBlindIndex].acted = false;
  table.players[bigBlindIndex].acted = false;

  const firstPlayer =
    nextPlayerIndex(table, bigBlindIndex);

  startBettingRound(table, firstPlayer);

  broadcastTable(table);
}

function advanceStreet(table) {
  collectBets(table);

  if (table.stage === "preflop") {
    dealFlop(table);
    table.stage = "flop";
  } else if (table.stage === "flop") {
    dealTurn(table);
    table.stage = "turn";
  } else if (table.stage === "turn") {
    dealRiver(table);
    table.stage = "river";
  } else if (table.stage === "river") {
    showdown(table);
    return;
  }

  table.currentBet = 0;
  table.minimumRaise = BIG_BLIND;

  for (const player of table.players) {
    player.acted = false;
    player.bet = 0;
  }

  const first = nextPlayerIndex(
    table,
    table.dealerIndex
  );

  startBettingRound(table, first);

  broadcastTable(table);
}

function checkForRoundEnd(table) {
  const active = activePlayers(table);

  if (active.length === 1) {
    finishHand(table, active[0]);
    return true;
  }

  const able = playersAbleToAct(table);

  if (able.length === 0) {
    advanceStreet(table);
    return true;
  }

  if (everyoneActed(table)) {
    advanceStreet(table);
    return true;
  }

  return false;
}

function cardValue(card) {
  const rank = card[0];

  if (rank === "T") return 10;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  if (rank === "A") return 14;

  return Number(rank);
}

function evaluateHighCard(cards) {
  return cards
    .map(cardValue)
    .sort((a, b) => b - a);
}

function evaluateHand(cards) {
  const values = cards
    .map(cardValue)
    .sort((a, b) => b - a);

  const suits = {};
  const counts = {};

  for (const card of cards) {
    const suit = card[1];

    suits[suit] = (suits[suit] || 0) + 1;

    const value = cardValue(card);
    counts[value] = (counts[value] || 0) + 1;
  }

  const flushSuit = Object.keys(suits)
    .find(s => suits[s] >= 5);

  let unique = [...new Set(values)].sort((a, b) => b - a);

  if (unique.includes(14)) {
    unique.push(1);
  }

  let straightHigh = null;

  for (let i = 0; i <= unique.length - 5; i++) {
    const sequence = unique.slice(i, i + 5);

    if (sequence[0] - sequence[4] === 4) {
      straightHigh = sequence[0];
      break;
    }
  }

  if (flushSuit) {
    const flushCards = cards
      .filter(c => c[1] === flushSuit)
      .map(cardValue)
      .sort((a, b) => b - a);

    if (flushCards.includes(14)) {
      flushCards.push(1);
    }

    for (let i = 0; i <= flushCards.length - 5; i++) {
      if (
        flushCards[i] - flushCards[i + 4] === 4
      ) {
        return {
          rank: 8,
          values: [flushCards[i]]
        };
      }
    }
  }

  const quads = Object.entries(counts)
    .filter(([, count]) => count === 4)
    .map(([value]) => Number(value))
    .sort((a, b) => b - a);

  if (quads.length) {
    const kicker = values.find(v => v !== quads[0]);

    return {
      rank: 7,
      values: [quads[0], kicker]
    };
  }

  const trips = Object.entries(counts)
    .filter(([, count]) => count >= 3)
    .map(([value]) => Number(value))
    .sort((a, b) => b - a);

  const pairs = Object.entries(counts)
    .filter(([, count]) => count >= 2)
    .map(([value]) => Number(value))
    .sort((a, b) => b - a);

  if (trips.length >= 2) {
    return {
      rank: 6,
      values: [trips[0], trips[1]]
    };
  }

  if (trips.length === 1 && pairs.length >= 2) {
    return {
      rank: 6,
      values: [trips[0], pairs.find(v => v !== trips[0])]
    };
  }

  if (flushSuit) {
    const flushCards = cards
      .filter(c => c[1] === flushSuit)
      .map(cardValue)
      .sort((a, b) => b - a);

    return {
      rank: 5,
      values: flushCards.slice(0, 5)
    };
  }

  if (straightHigh !== null) {
    return {
      rank: 4,
      values: [straightHigh]
    };
  }

  if (trips.length === 1) {
    const kickers = values
      .filter(v => v !== trips[0])
      .slice(0, 2);

    return {
      rank: 3,
      values: [trips[0], ...kickers]
    };
  }

  if (pairs.length >= 2) {
    const highPair = pairs[0];
    const lowPair = pairs[1];
    const kicker = values.find(
      v => v !== highPair && v !== lowPair
    );

    return {
      rank: 2,
      values: [highPair, lowPair, kicker]
    };
  }

  if (pairs.length === 1) {
    const kickers = values
      .filter(v => v !== pairs[0])
      .slice(0, 3);

    return {
      rank: 1,
      values: [pairs[0], ...kickers]
    };
  }

  return {
    rank: 0,
    values: values.slice(0, 5)
  };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }

  const length = Math.max(
    a.values.length,
    b.values.length
  );

  for (let i = 0; i < length; i++) {
    const av = a.values[i] || 0;
    const bv = b.values[i] || 0;

    if (av !== bv) {
      return av - bv;
    }
  }

  return 0;
}

function showdown(table) {
  collectBets(table);

  const players = activePlayers(table);

  let bestPlayer = null;
  let bestHand = null;

  for (const player of players) {
    const allCards = [
      ...player.cards,
      ...table.communityCards
    ];

    const hand = evaluateHand(allCards);

    if (
      !bestHand ||
      compareHands(hand, bestHand) > 0
    ) {
      bestHand = hand;
      bestPlayer = player;
    }
  }

  if (bestPlayer) {
    finishHand(table, bestPlayer);
  }
}

function finishHand(table, winner) {
  if (!winner) return;

  winner.chips += table.pot;

  table.winner = winner.id;
  table.message =
    `${winner.name} wins ${table.pot} chips`;

  table.pot = 0;
  table.stage = "showdown";
  table.started = false;
  table.turnStartedAt = null;
  table.currentPlayerIndex = -1;

  broadcastTable(table);

  setTimeout(() => {
    moveWaitingPlayers(table);

    if (table.players.length >= 2) {
      table.dealerIndex =
        (table.dealerIndex + 1) %
        table.players.length;

      startHand(table);
    } else {
      table.stage = "waiting";
      table.winner = null;
      table.message = "Waiting for players";
      broadcastTable(table);
    }
  }, 3000);
}

function moveWaitingPlayers(table) {
  while (
    table.waiting.length > 0 &&
    table.players.length < MAX_PLAYERS
  ) {
    const player = table.waiting.shift();

    if (
      !table.players.some(p => p.id === player.id)
    ) {
      table.players.push(player);
    }
  }
}

function addBots(table) {
  let bots = table.players.filter(p => p.isBot).length;

  while (
    bots < BOTS_PER_TABLE &&
    table.players.length < MAX_PLAYERS
  ) {
    const bot = createPlayer(
      `bot_${table.id}_${Date.now()}_${bots}`,
      `Player ${bots + 1}`,
      true
    );

    table.players.push(bot);
    bots++;
  }
}

function performAction(
  table,
  playerId,
  action,
  amount = 0
) {
  const player = table.players.find(
    p => p.id === playerId
  );

  if (!player) {
    return {
      success: false,
      error: "Player not found"
    };
  }

  const current = getCurrentPlayer(table);

  if (!current || current.id !== playerId) {
    return {
      success: false,
      error: "Not your turn"
    };
  }

  if (player.folded || player.allIn) {
    return {
      success: false,
      error: "Invalid player state"
    };
  }

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
  }

  else if (action === "check") {
    if (player.bet !== table.currentBet) {
      return {
        success: false,
        error: "Cannot check"
      };
    }

    player.acted = true;
  }

  else if (action === "call") {
    const needed =
      table.currentBet - player.bet;

    placeBet(player, needed);
    player.acted = true;
  }

  else if (action === "raise") {
    const raiseTo = Number(amount);

    if (!Number.isFinite(raiseTo)) {
      return {
        success: false,
        error: "Invalid raise"
      };
    }

    if (raiseTo <= table.currentBet) {
      return {
        success: false,
        error: "Raise must be higher"
      };
    }

    const needed = raiseTo - player.bet;

    if (needed > player.chips) {
      return {
        success: false,
        error: "Not enough chips"
      };
    }

    const previousBet = table.currentBet;

    placeBet(player, needed);

    table.currentBet = player.bet;

    table.minimumRaise =
      Math.max(
        BIG_BLIND,
        table.currentBet - previousBet
      );

    for (const p of table.players) {
      if (
        p.id !== player.id &&
        !p.folded &&
        !p.allIn
      ) {
        p.acted = false;
      }
    }

    player.acted = true;
  }

  else if (action === "allin") {
    const oldCurrentBet = table.currentBet;

    placeBet(player, player.chips);
    player.acted = true;

    if (player.bet > table.currentBet) {
      table.currentBet = player.bet;

      table.minimumRaise =
        Math.max(
          BIG_BLIND,
          table.currentBet - oldCurrentBet
        );

      for (const p of table.players) {
        if (
          p.id !== player.id &&
          !p.folded &&
          !p.allIn
        ) {
          p.acted = false;
        }
      }
    }
  }

  else {
    return {
      success: false,
      error: "Unknown action"
    };
  }

  checkForRoundEnd(table);

  if (table.started) {
    setNextTurn(table);
    broadcastTable(table);
  }

  return {
    success: true
  };
}

function botAction(table) {
  const bot = getCurrentPlayer(table);

  if (!bot || !bot.isBot || !table.started) {
    return;
  }

  const callAmount =
    table.currentBet - bot.bet;

  let action;

  const random = Math.random();

  if (random < 0.08) {
    action = "fold";
  } else if (callAmount === 0) {
    if (random < 0.55) {
      action = "check";
    } else {
      action = "raise";
    }
  } else if (random < 0.7) {
    action = "call";
  } else if (random < 0.9) {
    action = "raise";
  } else {
    action = "allin";
  }

  if (action === "raise") {
    const raiseAmount =
      Math.min(
        bot.chips + bot.bet,
        table.currentBet +
          Math.max(
            table.minimumRaise,
            BIG_BLIND
          )
      );

    performAction(
      table,
      bot.id,
      "raise",
      raiseAmount
    );
  } else {
    performAction(
      table,
      bot.id,
      action
    );
  }
}

function serializeTable(table, viewerId = null) {
  const current =
    getCurrentPlayer(table);

  return {
    id: table.id,
    started: table.started,
    stage: table.stage,
    pot: table.pot +
      table.players.reduce(
        (sum, p) => sum + p.bet,
        0
      ),
    communityCards: table.communityCards,
    currentBet: table.currentBet,
    winner: table.winner,
    message: table.message,
    dealerIndex: table.dealerIndex,
    currentPlayer:
      current ? current.id : null,
    currentPlayerName:
      current ? current.name : null,
    turnStartedAt: table.turnStartedAt,
    turnSeconds: TURN_SECONDS,

    players: table.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      isBot: p.isBot,
      isTurn:
        index === table.currentPlayerIndex,

      cards:
        p.id === viewerId || p.folded
          ? p.cards
          : []
    }))
  };
}

function broadcastTable(table) {
  const payload = JSON.stringify({
    type: "table_update",
    table: serializeTable(table)
  });

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.tableId === table.id
    ) {
      client.send(payload);
    }
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Telegram Poker Backend"
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
      waiting: table.waiting.length,
      started: table.started,
      stage: table.stage
    }))
  });
});

app.get("/game/:tableId", (req, res) => {
  const table =
    tables.find(
      t => t.id === Number(req.params.tableId)
    );

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  const viewerId = req.query.playerId || null;

  res.json({
    success: true,
    game: serializeTable(table, viewerId)
  });
});

app.get(
  "/my-cards/:tableId/:playerId",
  (req, res) => {
    const table =
      tables.find(
        t => t.id === Number(req.params.tableId)
      );

    if (!table) {
      return res.status(404).json({
        success: false,
        error: "Table not found"
      });
    }

    const player =
      table.players.find(
        p => p.id === req.params.playerId
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
  }
);

app.post("/join", (req, res) => {
  const {
    tableId,
    playerId,
    name
  } = req.body;

  const table =
    tables.find(
      t => t.id === Number(tableId)
    );

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  const existing =
    table.players.find(
      p => p.id === String(playerId)
    );

  if (existing) {
    return res.json({
      success: true,
      waiting: false,
      game: serializeTable(
        table,
        String(playerId)
      )
    });
  }

  const waiting =
    table.waiting.find(
      p => p.id === String(playerId)
    );

  if (waiting) {
    return res.json({
      success: true,
      waiting: true,
      game: serializeTable(
        table,
        String(playerId)
      )
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
        "You will join the next hand"
    });
  }

  table.players.push(player);

  addBots(table);

  if (
    table.players.length >= 2 &&
    !table.started
  ) {
    startHand(table);
  }

  broadcastTable(table);

  res.json({
    success: true,
    waiting: false,
    game: serializeTable(
      table,
      String(playerId)
    )
  });
});

app.post("/leave", (req, res) => {
  const {
    tableId,
    playerId
  } = req.body;

  const table =
    tables.find(
      t => t.id === Number(tableId)
    );

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  table.players =
    table.players.filter(
      p => p.id !== String(playerId)
    );

  table.waiting =
    table.waiting.filter(
      p => p.id !== String(playerId)
    );

  if (table.players.length < 2) {
    table.started = false;
    table.stage = "waiting";
    table.currentPlayerIndex = -1;
    table.turnStartedAt = null;
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
    tables.find(
      t => t.id === Number(tableId)
    );

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
      amount || 0
    );

  res.json({
    ...result,
    game: serializeTable(
      table,
      String(playerId)
    )
  });
});

app.post("/reset", (req, res) => {
  const table =
    tables.find(
      t => t.id === Number(req.body.tableId)
    );

  if (!table) {
    return res.status(404).json({
      success: false,
      error: "Table not found"
    });
  }

  table.players = [];
  table.waiting = [];
  table.deck = [];
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = 0;
  table.stage = "waiting";
  table.started = false;
  table.winner = null;
  table.message = "";
  table.currentPlayerIndex = -1;
  table.turnStartedAt = null;

  broadcastTable(table);

  res.json({
    success: true
  });
});

wss.on("connection", ws => {
  ws.tableId = null;

  ws.on("message", message => {
    try {
      const data =
        JSON.parse(message.toString());

      if (data.type === "join_table") {
        ws.tableId =
          Number(data.tableId);

        const table =
          tables.find(
            t => t.id === ws.tableId
          );

        if (table) {
          ws.send(
            JSON.stringify({
              type: "table_update",
              table: serializeTable(
                table,
                data.playerId || null
              )
            })
          );
        }
      }
    } catch (error) {
      console.error(
        "WebSocket error:",
        error.message
      );
    }
  });
});

setInterval(() => {
  for (const table of tables) {
    if (!table.started) continue;

    const current =
      getCurrentPlayer(table);

    if (!current) continue;

    if (
      table.turnStartedAt &&
      Date.now() -
        table.turnStartedAt >=
        TURN_SECONDS * 1000
    ) {
      if (current.isBot) {
        botAction(table);
      } else {
        performAction(
          table,
          current.id,
          "fold"
        );
      }

      continue;
    }

    if (current.isBot) {
      const elapsed =
        Date.now() -
        table.turnStartedAt;

      if (elapsed > 1200) {
        botAction(table);
      }
    }
  }
}, 500);

server.listen(PORT, () => {
  console.log(
    `Poker server running on port ${PORT}`
  );
});
