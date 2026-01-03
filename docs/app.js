import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";
import { createNewGameState } from "./engine/state.js";
import { drawToEight, applyIntentStrict } from "./engine/rules.js";

const firebaseConfig = {
    apiKey: "AIzaSyBD8W2tS2BVpei46H_W4GJ9nOUM4AF2lQo",
    authDomain: "knk-ecg.firebaseapp.com",
    projectId: "knk-ecg",
    storageBucket: "knk-ecg.firebasestorage.app",
    messagingSenderId: "992239709436",
    appId: "1:992239709436:web:edcec37ba6de5148df3b79"
  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);

const submitIntent = httpsCallable(functions, "submitIntent");

let unsub = null;
let gameId = null;
let localSide = "W";
let state = null;

// UI
const elStatus = document.getElementById("status");
const elInfo = document.getElementById("info");
const elBoard = document.getElementById("board");
const elHand = document.getElementById("hand");
const elLog = document.getElementById("log");

document.getElementById("btnCreate").onclick = async () => {
  gameId = crypto.randomUUID().slice(0,8);
  localSide = "W";
  const s = createNewGameState();
  s.players.W.uid = "local";
  await setDoc(doc(db, "games", gameId), {
    state: s,
    rev: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    status: "ONGOING"
  });
  connect(gameId);
};

document.getElementById("btnJoin").onclick = async () => {
  gameId = document.getElementById("gameIdInput").value.trim();
  if(!gameId) return;
  localSide = "B";
  connect(gameId);
};

document.getElementById("btnVsAI").onclick = async () => {
  // Local-only quick start (no firestore)
  localSide = "W";
  state = createNewGameState({ vsAI:true, aiSide:"B" });
  render();
};

async function connect(id){
  if(unsub) unsub();
  const ref = doc(db, "games", id);
  unsub = onSnapshot(ref, (snap) => {
    if(!snap.exists()){
      elStatus.textContent = "Game not found";
      return;
    }
    const data = snap.data();
    state = data.state;
    elStatus.textContent = `Connected: ${id} (rev ${data.rev})`;
    render();
  });
}

function render(){
  if(!state){
    elInfo.textContent = "No game loaded.";
    return;
  }
  elInfo.textContent = JSON.stringify({
    phase: state.phase,
    inCheck: state.threat?.inCheck,
    result: state.result
  }, null, 2);

  renderBoard();
  renderHand();
  renderLog();
}

function renderBoard(){
  elBoard.innerHTML = "";
  const files = ["a","b","c","d","e","f","g","h"];
  for(let r=8;r>=1;r--){
    for(let f=0;f<8;f++){
      const square = `${files[f]}${r}`;
      const isDark = (f + r) % 2 === 0;
      const div = document.createElement("div");
      div.className = `square ${isDark ? "dark":"light"}`;
      const pid = state.board?.[square];
      if(pid){
        const p = state.pieces[pid];
        const chip = document.createElement("div");
        chip.className = "piece";
        chip.textContent = `${p.side}${p.type}`;
        div.appendChild(chip);
      }
      elBoard.appendChild(div);
    }
  }
}

function renderHand(){
  elHand.innerHTML = "";
  const hand = state.cards?.[localSide]?.hand || [];
  for(const cid of hand){
    const c = state.cardInstances[cid];
    const div = document.createElement("div");
    div.className = "card";
    div.textContent = c.kind;
    elHand.appendChild(div);
  }
}

function renderLog(){
  elLog.innerHTML = "";
  (state.log || []).slice(-20).forEach(e=>{
    const row = document.createElement("div");
    row.textContent = e.summary;
    elLog.appendChild(row);
  });
}

// OPTIONAL: local simulation helper (offline dev)
window._localApply = (intent) => {
  const s = applyIntentStrict(state, intent);
  state = s;
  render();
};

// In live mode, you'll call submitIntent({gameId,intent}) once UI builds intents.
window._submit = async (intent) => {
  if(!gameId) throw new Error("No gameId");
  await submitIntent({ gameId, intent });
};
