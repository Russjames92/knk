const COUNTS = {
  KNIGHT: 16,
  PAWN: 8,
  KING: 5,
  ROOK: 1,
  QUEEN: 1,
  BISHOP: 1
};

function buildDeckInstances(){
  const instancesW = {};
  const instancesB = {};
  let id = 1;

  const add = (owner, kind) => {
    const cid = `c_${String(id++).padStart(4,"0")}`;
    const obj = { id: cid, owner, kind };
    (owner==="W" ? instancesW : instancesB)[cid] = obj;
  };

  for (const owner of ["W","B"]){
    for (const [kind, n] of Object.entries(COUNTS)){
      for (let i=0;i<n;i++) add(owner, kind);
    }
  }
  return { instancesW, instancesB };
}

module.exports = { COUNTS, buildDeckInstances };
