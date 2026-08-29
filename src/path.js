// SVG path data parser/normalizer and serializer.
//
// Canonical segment form used everywhere in SVB v0.1 (see SPEC §6):
//   { cmd: 'M'|'L'|'C'|'Q'|'A'|'Z', pts: [[x,y],...] , arc?: {rx,ry,rot,largeArc,sweep} }
// All commands are absolute; H/V/S/T and relative variants are normalized away.

const TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)|(\s+|,)/g;

export function parsePathData(d) {
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(d)) !== null) {
    if (m[1]) tokens.push({ t: 'cmd', v: m[1] });
    else if (m[2]) tokens.push({ t: 'num', v: parseFloat(m[2]) });
  }

  const segs = [];
  let i = 0;
  let cmd = null;

  const nextNum = () => {
    if (i >= tokens.length || tokens[i].t !== 'num') {
      throw new Error(`path data: expected number at token ${i} of "${d.slice(0, 60)}"`);
    }
    return tokens[i++].v;
  };
  const num = () => {
    // SVG allows omitted numbers to repeat the sign context; we only accept explicit ones.
    const v = nextNum();
    return v;
  };

  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let lastCtrl = null; // for S/T reflection

  const push = (c, pts, extra) => segs.push({ cmd: c, pts, ...extra });

  while (i < tokens.length) {
    const tok = tokens[i++];
    if (tok.t === 'cmd') cmd = tok.v;
    else { i--; throw new Error('path data: segment must start with a command'); }
    if (cmd == null) break;

    switch (cmd.toLowerCase()) {
      case 'm': {
        let x = num(), y = num();
        [x, y] = toAbs(cmd, x, y, cx, cy);
        if (segs.length === 0 || segs[segs.length - 1].cmd === 'Z') { /* fine */ }
        cx = x; cy = y; sx = x; sy = y;
        push('M', [[x, y]]);
        lastCtrl = null;
        // implicit lineto continuation
        while (peekNum(tokens, i)) {
          let nx = num(), ny = num();
          [nx, ny] = toAbs(cmd, nx, ny, cx, cy);
          cx = nx; cy = ny;
          push('L', [[nx, ny]]);
        }
        break;
      }
      case 'l': {
        do {
          let x = num(), y = num();
          [x, y] = toAbs(cmd, x, y, cx, cy);
          cx = x; cy = y;
          push('L', [[x, y]]);
          lastCtrl = null;
        } while (peekNum(tokens, i));
        break;
      }
      case 'h': {
        do {
          const x = cmd === cmd.toUpperCase() ? num() : cx + num();
          cx = x;
          push('L', [[x, cy]]);
          lastCtrl = null;
        } while (peekNum(tokens, i));
        break;
      }
      case 'v': {
        do {
          const y = cmd === cmd.toUpperCase() ? num() : cy + num();
          cy = y;
          push('L', [[cx, y]]);
          lastCtrl = null;
        } while (peekNum(tokens, i));
        break;
      }
      case 'c': {
        do {
          let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
          [x1, y1] = toAbs(cmd, x1, y1, cx, cy);
          [x2, y2] = toAbs(cmd, x2, y2, cx, cy);
          [x, y] = toAbs(cmd, x, y, cx, cy);
          push('C', [[x1, y1], [x2, y2], [x, y]]);
          cx = x; cy = y;
          lastCtrl = [x2, y2];
        } while (peekNum(tokens, i));
        break;
      }
      case 's': {
        do {
          let x2 = num(), y2 = num(), x = num(), y = num();
          const [x1, y1] = lastCtrl
            ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]]
            : [cx, cy];
          [x2, y2] = toAbs(cmd, x2, y2, cx, cy);
          [x, y] = toAbs(cmd, x, y, cx, cy);
          push('C', [[x1, y1], [x2, y2], [x, y]]);
          cx = x; cy = y;
          lastCtrl = [x2, y2];
        } while (peekNum(tokens, i));
        break;
      }
      case 'q': {
        do {
          let x1 = num(), y1 = num(), x = num(), y = num();
          [x1, y1] = toAbs(cmd, x1, y1, cx, cy);
          [x, y] = toAbs(cmd, x, y, cx, cy);
          push('Q', [[x1, y1], [x, y]]);
          cx = x; cy = y;
          lastCtrl = [x1, y1];
        } while (peekNum(tokens, i));
        break;
      }
      case 't': {
        do {
          const [x1, y1] = lastCtrl ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
          let x = num(), y = num();
          [x, y] = toAbs(cmd, x, y, cx, cy);
          push('Q', [[x1, y1], [x, y]]);
          cx = x; cy = y;
          lastCtrl = [x1, y1];
        } while (peekNum(tokens, i));
        break;
      }
      case 'a': {
        do {
          const rx = num(), ry = num(), rot = num();
          const largeArc = num() !== 0, sweep = num() !== 0;
          let x = num(), y = num();
          [x, y] = toAbs(cmd, x, y, cx, cy);
          push('A', [[x, y]], { arc: { rx: Math.abs(rx), ry: Math.abs(ry), rot, largeArc, sweep } });
          cx = x; cy = y;
          lastCtrl = null;
        } while (peekNum(tokens, i));
        break;
      }
      case 'z': case 'Z': {
        push('Z', []);
        cx = sx; cy = sy;
        lastCtrl = null;
        break;
      }
      default:
        throw new Error(`path data: unsupported command ${cmd}`);
    }
  }
  return segs;
}

function toAbs(cmd, x, y, cx, cy) {
  return cmd === cmd.toUpperCase() ? [x, y] : [cx + x, cy + y];
}

function peekNum(tokens, i) {
  return i < tokens.length && tokens[i].t === 'num';
}

export function serializePathData(segs) {
  const parts = [];
  for (const s of segs) {
    switch (s.cmd) {
      case 'M': parts.push(`M${f(s.pts[0][0])} ${f(s.pts[0][1])}`); break;
      case 'L': parts.push(`L${f(s.pts[0][0])} ${f(s.pts[0][1])}`); break;
      case 'C': parts.push(`C${s.pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' ')}`); break;
      case 'Q': parts.push(`Q${s.pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' ')}`); break;
      case 'A': parts.push(`A${f(s.arc.rx)} ${f(s.arc.ry)} ${f(s.arc.rot)} ${s.arc.largeArc ? 1 : 0} ${s.arc.sweep ? 1 : 0} ${f(s.pts[0][0])} ${f(s.pts[0][1])}`); break;
      case 'Z': parts.push('Z'); break;
    }
  }
  return parts.join('');
}

function f(n) {
  const r = Math.round(n * 100) / 100;
  return String(r);
}
