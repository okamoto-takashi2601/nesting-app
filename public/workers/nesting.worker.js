// Standalone Web Worker — no imports, no require(), all functions inlined.

function sanitizePoints(pts) {
  if (!pts || pts.length < 3) return pts;
  var clean = [];
  for (var i = 0; i < pts.length; i++) {
    if (isFinite(pts[i].x) && isFinite(pts[i].y)) clean.push(pts[i]);
  }
  var deduped = [clean[0]];
  for (var j = 1; j < clean.length; j++) {
    var prev = deduped[deduped.length - 1];
    if (Math.abs(clean[j].x - prev.x) > 0.001 || Math.abs(clean[j].y - prev.y) > 0.001) {
      deduped.push(clean[j]);
    }
  }
  if (deduped.length > 1) {
    var last = deduped[deduped.length - 1], first = deduped[0];
    if (Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001) {
      deduped.pop();
    }
  }
  return deduped.length >= 3 ? deduped : pts;
}

// Compute per-edge straight flags.
// Edge i = (pts[i], pts[(i+1)%n]).
// A vertex is a "hard corner" if the two edges meeting at it form an angle
// with sin >= 0.15 (≈ 8.6°). Arc-tessellation points have near-zero sin (< 8.6°).
// Edge i is "straight" if BOTH its endpoints are hard corners.
// This allows a polygon with mixed LINE+ARC geometry to have some straight edges.
function computeEdgeStraight(pts) {
  var n = pts.length;

  // Step 1: edge lengths
  var edgeLens = new Array(n);
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    var dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    edgeLens[i] = Math.sqrt(dx * dx + dy * dy);
  }

  // Step 2: chamfer edges — edge shorter than 20% of either adjacent edge
  var isChamfer = new Array(n);
  for (var i = 0; i < n; i++) {
    var len = edgeLens[i];
    var prev = edgeLens[(i - 1 + n) % n];
    var next = edgeLens[(i + 1) % n];
    isChamfer[i] = len < 0.001 || len < 0.2 * prev || len < 0.2 * next;
  }

  // Step 3: vertex is hard only if neither adjacent edge is a chamfer AND angle sin >= 0.15
  var vertexHard = new Array(n);
  for (var i = 0; i < n; i++) {
    if (isChamfer[(i - 1 + n) % n] || isChamfer[i]) { vertexHard[i] = false; continue; }
    var a = pts[(i - 1 + n) % n];
    var b = pts[i];
    var c = pts[(i + 1) % n];
    var ax = b.x - a.x, ay = b.y - a.y;
    var bx = c.x - b.x, by = c.y - b.y;
    var cross = Math.abs(ax * by - ay * bx);
    var lenA = edgeLens[(i - 1 + n) % n];
    var lenB = edgeLens[i];
    vertexHard[i] = (cross / (lenA * lenB)) >= 0.15;
  }

  // Step 4: edge is flush only if not a chamfer and both endpoints are hard
  var edgeStr = new Array(n);
  for (var i = 0; i < n; i++) {
    edgeStr[i] = !isChamfer[i] && vertexHard[i] && vertexHard[(i + 1) % n];
  }
  return edgeStr;
}

function isAllStraight(edgeStr) {
  for (var i = 0; i < edgeStr.length; i++) if (!edgeStr[i]) return false;
  return true;
}

function polygonArea(pts) {
  var n = pts.length;
  var area = 0;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function getBounds(pts) {
  var minX = pts[0].x, minY = pts[0].y, maxX = pts[0].x, maxY = pts[0].y;
  for (var i = 1; i < pts.length; i++) {
    if (pts[i].x < minX) minX = pts[i].x;
    if (pts[i].y < minY) minY = pts[i].y;
    if (pts[i].x > maxX) maxX = pts[i].x;
    if (pts[i].y > maxY) maxY = pts[i].y;
  }
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function translate(pts, tx, ty) {
  return pts.map(function(p) { return { x: p.x + tx, y: p.y + ty }; });
}

function transformHoles(holes, rot, normOffX, normOffY, tx, ty) {
  if (!holes || !holes.length) return undefined;
  return holes.map(function(hole) {
    var hpts = rot !== 0 ? rotatePoints(hole, rot) : hole.map(function(p) { return { x: p.x, y: p.y }; });
    hpts = translate(hpts, normOffX, normOffY);
    return translate(hpts, tx, ty);
  });
}

function rotatePoints(pts, angleDeg) {
  var rad = (angleDeg * Math.PI) / 180;
  var cos = Math.cos(rad);
  var sin = Math.sin(rad);
  return pts.map(function(p) {
    return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
  });
}

function normalize(v) {
  var len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function project(pts, axis) {
  var min = pts[0].x * axis.x + pts[0].y * axis.y;
  var max = min;
  for (var i = 1; i < pts.length; i++) {
    var d = pts[i].x * axis.x + pts[i].y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

// Edge-aware SAT: each edge uses its own gap (0 for straight edges, configSpacing for curved).
// This allows two shapes to be flush on straight-to-straight face contacts while maintaining
// configSpacing clearance wherever curved edges are involved.
function satOverlapAware(a, aEdgeStr, b, bEdgeStr, configSpacing) {
  var n, i, j, edge, axis, projA, projB, gap;

  n = a.length;
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    edge = { x: a[j].x - a[i].x, y: a[j].y - a[i].y };
    axis = normalize({ x: -edge.y, y: edge.x });
    projA = project(a, axis);
    projB = project(b, axis);
    gap = aEdgeStr[i] ? 0 : configSpacing;
    if (projA[1] + gap <= projB[0] || projB[1] + gap <= projA[0]) return false;
  }

  n = b.length;
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    edge = { x: b[j].x - b[i].x, y: b[j].y - b[i].y };
    axis = normalize({ x: -edge.y, y: edge.x });
    projA = project(a, axis);
    projB = project(b, axis);
    gap = bEdgeStr[i] ? 0 : configSpacing;
    if (projA[1] + gap <= projB[0] || projB[1] + gap <= projA[0]) return false;
  }

  return true;
}

function boundsOverlap(ba, bb, gap) {
  gap = gap || 0;
  return !(
    ba.maxX + gap <= bb.minX ||
    bb.maxX + gap <= ba.minX ||
    ba.maxY + gap <= bb.minY ||
    bb.maxY + gap <= ba.minY
  );
}

// overlapsAny: myEdgeStr = edge straight flags for pts.
// placedEdgeStr[i] = edge straight flags for placedList[i].
function overlapsAny(pts, myEdgeStr, placedList, placedBounds, placedEdgeStr, configSpacing) {
  var pb = getBounds(pts);
  for (var i = 0; i < placedList.length; i++) {
    // Conservative bounds check with configSpacing; SAT uses per-edge gaps.
    if (boundsOverlap(pb, placedBounds[i], configSpacing) &&
        satOverlapAware(pts, myEdgeStr, placedList[i], placedEdgeStr[i], configSpacing)) {
      return true;
    }
  }
  return false;
}

// ── Boundary helpers ──────────────────────────────────────────────────────────

function pointInPolygon(px, py, pts) {
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function segmentsIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
  var d1x = p2x - p1x, d1y = p2y - p1y;
  var d2x = p4x - p3x, d2y = p4y - p3y;
  var cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;
  var t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / cross;
  var u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / cross;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

// All part vertices inside boundary AND no part edges cross boundary edges.
function isFullyInsideBoundary(pts, boundary) {
  var bn = boundary.length;
  var pn = pts.length;
  for (var i = 0; i < pn; i++) {
    if (!pointInPolygon(pts[i].x, pts[i].y, boundary)) return false;
  }
  for (var pi = 0; pi < pn; pi++) {
    var p1 = pts[pi], p2 = pts[(pi + 1) % pn];
    for (var bi = 0; bi < bn; bi++) {
      var b1 = boundary[bi], b2 = boundary[(bi + 1) % bn];
      if (segmentsIntersect(p1.x, p1.y, p2.x, p2.y, b1.x, b1.y, b2.x, b2.y)) return false;
    }
  }
  return true;
}

// ── Candidate builder ─────────────────────────────────────────────────────────

// Build placement candidates for a new polygon (pts, w, h) against placed polygons.
// boundary: optional polygon — when defined, use boundary-aware candidate generation.
function buildCandidates(placedList, placedBounds, placedEdgeStr, pts, w, h, sw, sh, configSpacing, myEdgeStr, boundary) {
  var tol = 0.001;
  var myWall = 0;
  var raw;

  if (boundary) {
    // Use boundary centroid as first candidate
    var bcx = 0, bcy = 0;
    for (var bi0 = 0; bi0 < boundary.length; bi0++) { bcx += boundary[bi0].x; bcy += boundary[bi0].y; }
    bcx /= boundary.length; bcy /= boundary.length;
    raw = [[bcx - w / 2, bcy - h / 2]];
    // Snap part vertices to boundary vertices
    var bvStep = Math.max(1, Math.floor(boundary.length / 16));
    var pvStep = Math.max(1, Math.floor(pts.length / 6));
    for (var bvi = 0; bvi < boundary.length; bvi += bvStep) {
      var bv = boundary[bvi];
      for (var pvi = 0; pvi < pts.length; pvi += pvStep) {
        raw.push([bv.x - pts[pvi].x, bv.y - pts[pvi].y]);
      }
    }
  } else {
    raw = [[0, 0]];
  }

  for (var pi = 0; pi < placedList.length; pi++) {
    var pb = placedBounds[pi];
    var placed = placedList[pi];
    var pn = placed.length;
    var pEdgeStr = placedEdgeStr[pi];

    // AABB-edge candidates at both 0 and configSpacing gap to capture straight-face packing.
    var gaps = configSpacing > 0 ? [0, configSpacing] : [0];
    for (var gi = 0; gi < gaps.length; gi++) {
      var sp = gaps[gi];
      var rx = pb.maxX + sp;
      var by2 = pb.maxY + sp;
      if (boundary) {
        raw.push([rx, pb.minY]);
        raw.push([rx, pb.maxY]);
        raw.push([pb.minX, by2]);
        raw.push([pb.maxX, by2]);
      } else {
        if (rx + w + myWall <= sw + tol) {
          raw.push([rx, myWall]);
          if (pb.minY >= myWall - tol) raw.push([rx, pb.minY]);
          if (pb.maxY + h + myWall <= sh + tol) raw.push([rx, pb.maxY]);
        }
        if (by2 + h + myWall <= sh + tol) {
          raw.push([myWall, by2]);
          if (pb.minX >= myWall - tol) raw.push([pb.minX, by2]);
          if (pb.maxX + w + myWall <= sw + tol) raw.push([pb.maxX, by2]);
        }
      }
    }

    // Edge-sample candidates: push new polygon's vertex against placed polygon's edges.
    // Use per-edge offset based on whether the placed edge is straight.
    for (var ei = 0; ei < pn; ei++) {
      var ev1 = placed[ei];
      var ev2 = placed[(ei + 1) % pn];
      var edx = ev2.x - ev1.x;
      var edy = ev2.y - ev1.y;
      var elen = Math.sqrt(edx * edx + edy * edy);
      if (elen < tol) continue;
      var nx = edy / elen;
      var ny = -edx / elen;
      var edgeGap = pEdgeStr[ei] ? 0 : configSpacing;

      for (var ti = 0; ti <= 2; ti++) {
        var t = ti / 2;
        var sx = ev1.x + edx * t;
        var sy = ev1.y + edy * t;
        for (var ni = 0; ni < pts.length; ni++) {
          var nv = pts[ni];
          for (var nd = -1; nd <= 1; nd += 2) {
            var tx = sx - nv.x + nd * nx * edgeGap;
            var ty = sy - nv.y + nd * ny * edgeGap;
            if (boundary) {
              if (tx > -w && tx < sw && ty > -h && ty < sh) raw.push([tx, ty]);
            } else {
              if (tx >= myWall - tol && tx + w + myWall <= sw + tol &&
                  ty >= myWall - tol && ty + h + myWall <= sh + tol) {
                raw.push([tx, ty]);
              }
            }
          }
        }
      }
    }

    // Reverse: placed vertex touches new polygon's edge.
    var np = pts.length;
    for (var vi = 0; vi < pn; vi++) {
      var pv = placed[vi];
      for (var nei = 0; nei < np; nei++) {
        var nv1 = pts[nei];
        var nv2 = pts[(nei + 1) % np];
        var nedx = nv2.x - nv1.x;
        var nedy = nv2.y - nv1.y;
        var nelen = Math.sqrt(nedx * nedx + nedy * nedy);
        if (nelen < tol) continue;
        var nnx = nedy / nelen;
        var nny = -nedx / nelen;
        // Use this new edge's gap to determine push-off direction
        var newEdgeGap = myEdgeStr[nei] ? 0 : configSpacing;

        for (var ti2 = 0; ti2 <= 2; ti2++) {
          var t2 = ti2 / 2;
          var epx = nv1.x + nedx * t2;
          var epy = nv1.y + nedy * t2;
          for (var nd2 = -1; nd2 <= 1; nd2 += 2) {
            var tx2 = pv.x - nd2 * nnx * newEdgeGap - epx;
            var ty2 = pv.y - nd2 * nny * newEdgeGap - epy;
            if (boundary) {
              if (tx2 > -w && tx2 < sw && ty2 > -h && ty2 < sh) raw.push([tx2, ty2]);
            } else {
              if (tx2 >= myWall - tol && tx2 + w + myWall <= sw + tol &&
                  ty2 >= myWall - tol && ty2 + h + myWall <= sh + tol) {
                raw.push([tx2, ty2]);
              }
            }
          }
        }
      }
    }
  }

  // Sample boundary edges — place parts snug against irregular boundary
  if (boundary) {
    var bn = boundary.length;
    var edgeStep = Math.max(1, Math.floor(bn / 24));
    var pStep2 = Math.max(1, Math.floor(pts.length / 6));
    for (var bei = 0; bei < bn; bei += edgeStep) {
      var bev1 = boundary[bei];
      var bev2 = boundary[(bei + edgeStep) % bn];
      var bmx = (bev1.x + bev2.x) / 2;
      var bmy = (bev1.y + bev2.y) / 2;
      for (var bni = 0; bni < pts.length; bni += pStep2) {
        raw.push([bmx - pts[bni].x, bmy - pts[bni].y]);
      }
      raw.push([bev1.x - pts[0].x, bev1.y - pts[0].y]);
    }
  }

  raw.sort(function(a, b) {
    var dy = a[1] - b[1];
    return Math.abs(dy) > tol ? dy : a[0] - b[0];
  });

  var seen = {};
  var deduped = [];
  for (var di = 0; di < raw.length; di++) {
    var gx = Math.round(raw[di][0] * 2);
    var gy = Math.round(raw[di][1] * 2);
    var key = gx + ',' + gy;
    if (!seen[key]) {
      seen[key] = true;
      deduped.push(raw[di]);
    }
  }
  return deduped;
}

function makeRotations(step) {
  step = Math.max(1, Math.min(180, step || 90));
  var out = [];
  for (var a = 0; a < 360; a += step) out.push(a);
  return out;
}

var CHIDORI60_ROTS = [0, 60, 120, 180, 240, 300];
var CHIDORI30_ROTS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

function trialFit(sortedPolygons, rot, sw, sh, configSpacing, boundary) {
  var TRIAL_N = 8;
  var tol = 0.001;
  var trialPlaced = [], trialBounds = [], trialEdgeStr = [], fitted = 0;
  for (var pi = 0; pi < Math.min(sortedPolygons.length, TRIAL_N); pi++) {
    var p0 = sortedPolygons[pi].points;
    var myEdgeStr = sortedPolygons[pi].edgeStr;
    var pts = rot !== 0 ? rotatePoints(p0, rot) : p0.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(pts);
    pts = translate(pts, -b0.minX, -b0.minY);
    var b = getBounds(pts);
    var w = b.maxX, h = b.maxY;
    if (w > sw + tol || h > sh + tol) continue;
    var srcPlaced = trialPlaced.slice(Math.max(0, trialPlaced.length - 6));
    var srcBounds = trialBounds.slice(Math.max(0, trialBounds.length - 6));
    var srcEdgeStr = trialEdgeStr.slice(Math.max(0, trialEdgeStr.length - 6));
    var cands = buildCandidates(srcPlaced, srcBounds, srcEdgeStr, pts, w, h, sw, sh, configSpacing, myEdgeStr, boundary);
    for (var ci = 0; ci < cands.length; ci++) {
      var moved = translate(pts, cands[ci][0], cands[ci][1]);
      var mb = getBounds(moved);
      var validBounds = boundary
        ? isFullyInsideBoundary(moved, boundary)
        : (mb.minX >= -tol && mb.minY >= -tol && mb.maxX <= sw + tol && mb.maxY <= sh + tol);
      if (!validBounds) continue;
      if (!overlapsAny(moved, myEdgeStr, trialPlaced, trialBounds, trialEdgeStr, configSpacing)) {
        trialPlaced.push(moved); trialBounds.push(getBounds(moved)); trialEdgeStr.push(myEdgeStr);
        fitted++; break;
      }
    }
  }
  return fitted;
}

function pickBestUniformRotation(sortedPolygons, candidateRots, sw, sh, configSpacing, boundary) {
  var bestRot = candidateRots[0], bestFitted = -1;
  for (var ri = 0; ri < candidateRots.length; ri++) {
    var fitted = trialFit(sortedPolygons, candidateRots[ri], sw, sh, configSpacing, boundary);
    if (fitted > bestFitted) { bestFitted = fitted; bestRot = candidateRots[ri]; }
  }
  return bestRot;
}

function tryRotations(pts0, edgeStr0, rotations, placed, placedBounds, placedEdgeStr, srcStart, sw, sh, configSpacing, boundary) {
  var tol = 0.001;
  var myEdgeStr = edgeStr0;
  var best = null;
  var bestScore = Infinity;
  var srcPlaced = placed.slice(srcStart);
  var srcBounds = placedBounds.slice(srcStart);
  var srcEdgeStr = placedEdgeStr.slice(srcStart);

  for (var ri = 0; ri < rotations.length; ri++) {
    var rot = rotations[ri];
    var pts = rot !== 0
      ? rotatePoints(pts0, rot)
      : pts0.map(function(p) { return { x: p.x, y: p.y }; });

    var b0 = getBounds(pts);
    pts = translate(pts, -b0.minX, -b0.minY);
    var b = getBounds(pts);
    var w = b.maxX, h = b.maxY;
    if (w > sw + tol || h > sh + tol) continue;

    var candidates = buildCandidates(srcPlaced, srcBounds, srcEdgeStr, pts, w, h, sw, sh, configSpacing, myEdgeStr, boundary);

    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = candidates[ci];
      var moved = translate(pts, cand[0], cand[1]);
      var mb = getBounds(moved);
      var validBounds = boundary
        ? isFullyInsideBoundary(moved, boundary)
        : (mb.minX >= -tol && mb.minY >= -tol && mb.maxX <= sw + tol && mb.maxY <= sh + tol);
      if (!validBounds) continue;
      if (overlapsAny(moved, myEdgeStr, placed, placedBounds, placedEdgeStr, configSpacing)) continue;

      var score = cand[1] * sw + cand[0];
      if (score < bestScore) {
        bestScore = score;
        best = { pts: moved, rot: rot, score: score };
      }
      break;
    }
  }
  return best;
}

var COARSE_ROTS = makeRotations(15);

// Returns which AABB face ('right','left','top','bottom') the straight edges are concentrated on.
function getStraightEdgeFace(pts, edgeStr) {
  var n = pts.length;
  var b = getBounds(pts);
  var cx = (b.minX + b.maxX) / 2;
  var cy = (b.minY + b.maxY) / 2;
  var votes = { right: 0, left: 0, top: 0, bottom: 0 };
  for (var i = 0; i < n; i++) {
    if (!edgeStr[i]) continue;
    var j = (i + 1) % n;
    var mx = (pts[i].x + pts[j].x) / 2;
    var my = (pts[i].y + pts[j].y) / 2;
    var dx = mx - cx, dy = my - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx > 0) votes.right++; else votes.left++;
    } else {
      if (dy > 0) votes.top++; else votes.bottom++;
    }
  }
  var best = 'right', bestV = -1;
  var keys = ['right', 'left', 'top', 'bottom'];
  for (var k = 0; k < keys.length; k++) {
    if (votes[keys[k]] > bestV) { bestV = votes[keys[k]]; best = keys[k]; }
  }
  return best;
}

function dropY(pts, tx, placed, placedBounds, placedEdgeStr, sheetH, configSpacing, myEdgeStr) {
  var h = getBounds(pts).maxY;
  var yMin = 0;
  var yMax = sheetH - h;
  if (yMax < yMin) return null;
  if (!overlapsAny(translate(pts, tx, yMin), myEdgeStr, placed, placedBounds, placedEdgeStr, configSpacing)) return yMin;
  if (overlapsAny(translate(pts, tx, yMax), myEdgeStr, placed, placedBounds, placedEdgeStr, configSpacing)) return null;
  var lo = yMin, hi = yMax;
  while (hi - lo > 0.25) {
    var mid = (lo + hi) / 2;
    if (overlapsAny(translate(pts, tx, mid), myEdgeStr, placed, placedBounds, placedEdgeStr, configSpacing)) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Returns true if any straight edge's midpoint is close to the given AABB face.
function hasStraightOnFace(pts, edgeStr, face) {
  var n = pts.length;
  var b = getBounds(pts);
  var faceTol = 2;
  for (var i = 0; i < n; i++) {
    if (!edgeStr[i]) continue;
    var j = (i + 1) % n;
    var mx = (pts[i].x + pts[j].x) / 2;
    var my = (pts[i].y + pts[j].y) / 2;
    if (face === 'right'  && mx >= b.maxX - faceTol) return true;
    if (face === 'left'   && mx <= b.minX + faceTol) return true;
    if (face === 'top'    && my >= b.maxY - faceTol) return true;
    if (face === 'bottom' && my <= b.minY + faceTol) return true;
  }
  return false;
}

// Pick best uniform rotation for same-direction mode.
// Prefers rotations that put a straight edge on the RIGHT or BOTTOM face.
// Falls back to the rotation that fits the most parts.
function pickSameRotation(sortedPolygons, candidateRots, sw, sh, spacing) {
  var MARGIN = 5;
  var tol = 0.001;
  var bestRot = candidateRots[0];
  var bestScore = -1;

  for (var ri = 0; ri < candidateRots.length; ri++) {
    var rot = candidateRots[ri];
    var poly0 = sortedPolygons[0];
    var pts = rot !== 0
      ? rotatePoints(poly0.points, rot)
      : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(pts);
    pts = translate(pts, -b0.minX, -b0.minY);
    var b = getBounds(pts);
    var w = b.maxX, h = b.maxY;
    if (w > sw - 2 * MARGIN + tol || h > sh - 2 * MARGIN + tol) continue;
    var es = poly0.edgeStr;
    var gapH = (hasStraightOnFace(pts, es, 'right') && hasStraightOnFace(pts, es, 'left'))  ? 0 : spacing;
    var gapV = (hasStraightOnFace(pts, es, 'bottom') && hasStraightOnFace(pts, es, 'top')) ? 0 : spacing;
    var perRow = Math.floor((sw - 2 * MARGIN + gapH) / (w + gapH));
    var rows   = Math.floor((sh - 2 * MARGIN + gapV) / (h + gapV));
    if (perRow < 1 || rows < 1) continue;
    var count = perRow * rows;
    var bonus = 0;
    if (hasStraightOnFace(pts, es, 'right') || hasStraightOnFace(pts, es, 'bottom')) bonus = 1;
    var score = count * 10 + bonus;
    if (score > bestScore) { bestScore = score; bestRot = rot; }
  }
  return bestRot;
}

// Same-direction layout: uniform rotation, row-template grid, 5mm sheet margin.
function nestSame(sorted, sw, sh, spacing, uniformRot, boundary) {
  var MARGIN = 5;
  var tol = 0.001;
  var results = [];
  var unplaced = [];

  var rot = uniformRot !== null ? uniformRot : 0;

  // Rotate and normalize all parts
  var prep = [];
  for (var i = 0; i < sorted.length; i++) {
    var poly = sorted[i];
    var pts = rot !== 0
      ? rotatePoints(poly.points, rot)
      : poly.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(pts);
    pts = translate(pts, -b0.minX, -b0.minY);
    var b = getBounds(pts);
    var w = b.maxX, h = b.maxY;
    if (w > sw - 2 * MARGIN + tol || h > sh - 2 * MARGIN + tol) {
      unplaced.push(poly.id); continue;
    }
    prep.push({ poly: poly, pts: pts, w: w, h: h, b0: b0 });
  }

  if (prep.length === 0) return { results: results, unplaced: unplaced };

  // Gaps: 0 if both touching faces are straight, else spacing
  var rep = prep[0];
  var repEs = rep.poly.edgeStr;
  var gapH = (hasStraightOnFace(rep.pts, repEs, 'right') && hasStraightOnFace(rep.pts, repEs, 'left'))   ? 0 : spacing;
  var gapV = (hasStraightOnFace(rep.pts, repEs, 'bottom') && hasStraightOnFace(rep.pts, repEs, 'top')) ? 0 : spacing;

  // Build row 1 template: x positions and widths for each slot
  var rowSlots = [];
  var curX = MARGIN;
  var ti = 0;
  while (ti < prep.length) {
    var pw = prep[ti].w;
    if (curX + pw + MARGIN > sw + tol) break;
    rowSlots.push({ x: curX, w: pw });
    curX += pw + gapH;
    ti++;
  }

  if (rowSlots.length === 0) {
    for (var i = 0; i < prep.length; i++) unplaced.push(prep[i].poly.id);
    return { results: results, unplaced: unplaced };
  }

  var perRow = rowSlots.length;

  // Row height: max of parts used in row 1
  var rowH = 0;
  for (var ri = 0; ri < perRow; ri++) rowH = Math.max(rowH, prep[ri].h);

  // Place rows
  var pi = 0;
  var rowY = MARGIN;

  while (pi < prep.length) {
    if (rowY + rowH + MARGIN > sh + tol) break;
    for (var slot = 0; slot < perRow && pi < prep.length; slot++) {
      var p = prep[pi];
      var tx = rowSlots[slot].x;
      var ty = rowY;
      var moved = translate(p.pts, tx, ty);
      var holes = transformHoles(p.poly.holes, rot, -p.b0.minX, -p.b0.minY, tx, ty);
      results.push({ id: p.poly.id, label: p.poly.label, points: moved, holes: holes, rotation: rot, color: p.poly.color });
      pi++;
    }
    rowY += rowH + gapV;
    self.postMessage({ type: 'progress', placed: results, current: pi, total: sorted.length });
  }

  for (var j = pi; j < prep.length; j++) unplaced.push(prep[j].poly.id);
  return { results: results, unplaced: unplaced };
}

function nestStructured(sorted, sw, sh, spacing, layoutMode, uniformRot, initPlaced, initBounds, initEdgeStr, boundary) {
  var results = [];
  var placed = initPlaced.slice();
  var placedBounds = initBounds.slice();
  var placedEdgeStr = initEdgeStr.slice();
  var unplaced = [];
  var isChidori = layoutMode === 'chidori60' || layoutMode === 'chidori30';
  var tol = 0.001;

  if (!isChidori) {
    var MAX_SRC2 = 12;
    for (var si2 = 0; si2 < sorted.length; si2++) {
      var poly2 = sorted[si2];
      var myEdgeStr2 = poly2.edgeStr;
      var rot2;
      if (layoutMode === 'back-back') {
        var base2 = uniformRot !== null ? uniformRot : 0;
        rot2 = si2 % 2 === 0 ? base2 : (base2 + 180) % 360;
      } else {
        rot2 = uniformRot !== null ? uniformRot : 0;
      }
      var pts2 = rot2 !== 0
        ? rotatePoints(poly2.points, rot2)
        : poly2.points.map(function(p) { return { x: p.x, y: p.y }; });
      var b02 = getBounds(pts2);
      pts2 = translate(pts2, -b02.minX, -b02.minY);
      var b2 = getBounds(pts2);
      var w2 = b2.maxX, h2 = b2.maxY;

      if (w2 > sw || h2 > sh) {
        unplaced.push(poly2.id); continue;
      }

      var srcStart2 = Math.max(0, placed.length - MAX_SRC2);
      var cands2 = buildCandidates(
        placed.slice(srcStart2), placedBounds.slice(srcStart2), placedEdgeStr.slice(srcStart2),
        pts2, w2, h2, sw, sh, spacing, myEdgeStr2, boundary
      );

      var rowH2 = h2 + spacing;
      cands2.sort(function(a, b) {
        var ra = Math.floor(a[1] / rowH2);
        var rb = Math.floor(b[1] / rowH2);
        return ra !== rb ? ra - rb : a[0] - b[0];
      });

      // Back-to-back: for the partner (odd) part, try the straight-face-adjacent
      // position first — before bottom-left candidates that may touch a curved edge.
      if (layoutMode === 'back-back' && si2 % 2 === 1 && placed.length > 0) {
        var prevPb2 = placedBounds[placed.length - 1];
        var prevPts2x = placed[placed.length - 1];
        var prevEs2 = placedEdgeStr[placed.length - 1];
        var face2 = getStraightEdgeFace(prevPts2x, prevEs2);
        var pc2;
        if (face2 === 'right')  pc2 = [prevPb2.maxX, prevPb2.minY];
        else if (face2 === 'left')  pc2 = [prevPb2.minX - w2, prevPb2.minY];
        else if (face2 === 'top')   pc2 = [prevPb2.minX, prevPb2.maxY];
        else                        pc2 = [prevPb2.minX, prevPb2.minY - h2];
        cands2 = [pc2].concat(cands2);
      }

      var ok2 = false;
      for (var ci2 = 0; ci2 < cands2.length; ci2++) {
        var moved2 = translate(pts2, cands2[ci2][0], cands2[ci2][1]);
        var mb2 = getBounds(moved2);
        var validBounds2 = boundary
          ? isFullyInsideBoundary(moved2, boundary)
          : (mb2.minX >= -tol && mb2.minY >= -tol && mb2.maxX <= sw + tol && mb2.maxY <= sh + tol);
        if (!validBounds2) continue;
        if (!overlapsAny(moved2, myEdgeStr2, placed, placedBounds, placedEdgeStr, spacing)) {
          placed.push(moved2); placedBounds.push(mb2); placedEdgeStr.push(myEdgeStr2);
          var holes2 = transformHoles(poly2.holes, rot2, -b02.minX, -b02.minY, cands2[ci2][0], cands2[ci2][1]);
          results.push({ id: poly2.id, label: poly2.label, points: moved2, holes: holes2, rotation: rot2, color: poly2.color });
          ok2 = true;
          break;
        }
      }
      if (!ok2) unplaced.push(poly2.id);

      if ((si2 + 1) % 3 === 0 || si2 === sorted.length - 1) {
        self.postMessage({ type: 'progress', placed: results, current: si2 + 1, total: sorted.length });
      }
    }
    return { results: results, unplaced: unplaced };
  }

  // Chidori
  var cellPitch = 0;
  for (var pi = 0; pi < sorted.length; pi++) {
    var rot0 = uniformRot !== null ? uniformRot : 0;
    var pp0 = rot0 !== 0
      ? rotatePoints(sorted[pi].points, rot0)
      : sorted[pi].points.map(function(p) { return { x: p.x, y: p.y }; });
    var pb00 = getBounds(pp0);
    var pp0n = translate(pp0, -pb00.minX, -pb00.minY);
    var pb0n = getBounds(pp0n);
    var pw = pb0n.maxX, phh = pb0n.maxY;
    if (pw + 2 * spacing <= sw) {
      var d = Math.max(pw, phh) + spacing;
      cellPitch = layoutMode === 'chidori60' ? d : d * Math.sqrt(3);
      break;
    }
  }
  if (cellPitch === 0) {
    for (var ri0 = 0; ri0 < sorted.length; ri0++) unplaced.push(sorted[ri0].id);
    return { results: results, unplaced: unplaced };
  }

  var shelfIdx = 0;
  var shelfX = spacing;

  for (var si = 0; si < sorted.length; si++) {
    var poly = sorted[si];
    var myEdgeStrC = poly.edgeStr;
    var rot = uniformRot !== null ? uniformRot : 0;
    var pts = rot !== 0
      ? rotatePoints(poly.points, rot)
      : poly.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(pts);
    pts = translate(pts, -b0.minX, -b0.minY);
    var b = getBounds(pts);
    var w = b.maxX, h = b.maxY;

    if (w + 2 * spacing > sw || h + 2 * spacing > sh) {
      unplaced.push(poly.id); continue;
    }

    if (shelfX + w + spacing > sw + tol) {
      shelfIdx++;
      shelfX = spacing + (shelfIdx % 2 === 1 ? cellPitch / 2 : 0);
      if (shelfX + w + spacing > sw + tol) {
        shelfIdx++;
        shelfX = spacing + (shelfIdx % 2 === 1 ? cellPitch / 2 : 0);
      }
    }

    var y = dropY(pts, shelfX, placed, placedBounds, placedEdgeStr, sh, spacing, myEdgeStrC);
    if (y === null) { unplaced.push(poly.id); continue; }

    var moved = translate(pts, shelfX, y);
    var mb = getBounds(moved);

    if (boundary && !isFullyInsideBoundary(moved, boundary)) {
      unplaced.push(poly.id);
      continue;
    }

    if (mb.maxY > sh + tol || overlapsAny(moved, myEdgeStrC, placed, placedBounds, placedEdgeStr, spacing)) {
      unplaced.push(poly.id);
    } else {
      placed.push(moved); placedBounds.push(mb); placedEdgeStr.push(myEdgeStrC);
      var holesC = transformHoles(poly.holes, rot, -b0.minX, -b0.minY, shelfX, y);
      results.push({ id: poly.id, label: poly.label, points: moved, holes: holesC, rotation: rot, color: poly.color });
      shelfX += cellPitch;
    }

    if ((si + 1) % 3 === 0 || si === sorted.length - 1) {
      self.postMessage({ type: 'progress', placed: results, current: si + 1, total: sorted.length });
    }
  }

  return { results: results, unplaced: unplaced };
}

function nest(polygons, sheetConfig) {
  var sw = sheetConfig.width;
  var sh = sheetConfig.height;
  var spacing = sheetConfig.spacing || 0;
  var layoutMode = sheetConfig.layoutMode || 'free';
  var MAX_SRC = 12;

  // Extract boundary and obstacles from sheetConfig
  var boundary = null;
  if (sheetConfig.boundary && sheetConfig.boundary.length >= 3) {
    boundary = sanitizePoints(sheetConfig.boundary);
  }
  var rawObstacles = sheetConfig.obstacles || [];

  var sanitized = polygons.map(function(p) {
    var pts = sanitizePoints(p.points);
    var edgeStr = computeEdgeStraight(pts);
    return {
      id: p.id, label: p.label, color: p.color,
      points: pts,
      holes: p.holes ? p.holes.map(function(h) { return sanitizePoints(h); }) : undefined,
      edgeStr: edgeStr,
    };
  }).filter(function(p) { return p.points && p.points.length >= 3; });

  var labelMap = {};
  sanitized.forEach(function(p) {
    if (!labelMap[p.label]) labelMap[p.label] = [];
    labelMap[p.label].push(p);
  });
  var groups = [];
  for (var lbl in labelMap) {
    groups.push({ area: polygonArea(labelMap[lbl][0].points), parts: labelMap[lbl] });
  }
  groups.sort(function(a, b) { return b.area - a.area; });
  var maxLen = 0;
  groups.forEach(function(g) { if (g.parts.length > maxLen) maxLen = g.parts.length; });
  var sorted = [];
  for (var round = 0; round < maxLen; round++) {
    groups.forEach(function(g) { if (round < g.parts.length) sorted.push(g.parts[round]); });
  }

  // Pre-populate placed list with obstacle polygons (collision detection only, not in results)
  var initPlaced = [], initBounds = [], initEdgeStr = [];
  for (var oi = 0; oi < rawObstacles.length; oi++) {
    var obs = sanitizePoints(rawObstacles[oi]);
    if (!obs || obs.length < 3) continue;
    initPlaced.push(obs);
    initBounds.push(getBounds(obs));
    initEdgeStr.push(computeEdgeStraight(obs));
  }

  var uniformRot = null;
  if (layoutMode === 'chidori60') {
    uniformRot = pickBestUniformRotation(sorted, CHIDORI60_ROTS, sw, sh, spacing, boundary);
  } else if (layoutMode === 'chidori30') {
    uniformRot = pickBestUniformRotation(sorted, CHIDORI30_ROTS, sw, sh, spacing, boundary);
  } else if (layoutMode === 'same') {
    uniformRot = pickSameRotation(sorted, COARSE_ROTS, sw, sh, spacing);
  } else if (layoutMode === 'back-back') {
    uniformRot = pickBestUniformRotation(sorted, COARSE_ROTS, sw, sh, spacing, boundary);
  }

  var finalResults, finalUnplaced;

  if (layoutMode === 'same') {
    var out = nestSame(sorted, sw, sh, spacing, uniformRot, boundary);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else if (layoutMode !== 'free') {
    var out = nestStructured(sorted, sw, sh, spacing, layoutMode, uniformRot, initPlaced, initBounds, initEdgeStr, boundary);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else {
    var placed = initPlaced.slice();
    var placedBounds = initBounds.slice();
    var placedEdgeStr = initEdgeStr.slice();
    var results = [], unplaced = [];

    for (var si = 0; si < sorted.length; si++) {
      var poly = sorted[si];
      var myEdgeStr = poly.edgeStr;
      var srcStart = Math.max(0, placed.length - MAX_SRC);

      var coarse = tryRotations(poly.points, myEdgeStr, COARSE_ROTS, placed, placedBounds, placedEdgeStr, srcStart, sw, sh, spacing, boundary);
      var best = coarse;
      if (coarse !== null) {
        var center = coarse.rot;
        var fineRots = [];
        for (var da = -14; da <= 14; da++) {
          if (da === 0) continue;
          fineRots.push(((center + da) % 360 + 360) % 360);
        }
        var fine = tryRotations(poly.points, myEdgeStr, fineRots, placed, placedBounds, placedEdgeStr, srcStart, sw, sh, spacing, boundary);
        if (fine && fine.score < coarse.score) best = fine;
      }

      if (best) {
        placed.push(best.pts);
        placedBounds.push(getBounds(best.pts));
        placedEdgeStr.push(myEdgeStr);
        var bestHoles;
        if (poly.holes && poly.holes.length) {
          var outerRot = best.rot !== 0 ? rotatePoints(poly.points, best.rot) : poly.points;
          var outerB = getBounds(outerRot);
          var bestB = getBounds(best.pts);
          bestHoles = transformHoles(poly.holes, best.rot, -outerB.minX, -outerB.minY, bestB.minX, bestB.minY);
        }
        results.push({ id: poly.id, label: poly.label, points: best.pts, holes: bestHoles, rotation: best.rot, color: poly.color });
      } else {
        unplaced.push(poly.id);
      }

      if ((si + 1) % 3 === 0 || si === sorted.length - 1) {
        self.postMessage({ type: 'progress', placed: results, current: si + 1, total: sorted.length });
      }
    }

    finalResults = results;
    finalUnplaced = unplaced;
  }

  // Use boundary area for efficiency when boundary polygon is defined
  var sheetArea = boundary ? polygonArea(boundary) : sw * sh;
  var partsArea = finalResults.reduce(function(sum, r) { return sum + polygonArea(r.points); }, 0);
  var efficiency = sheetArea > 0 ? Math.round((partsArea / sheetArea) * 100) : 0;
  var lossArea = Math.round(sheetArea - partsArea);
  var placedCount = finalResults.length;
  var sheetsNeeded = placedCount > 0
    ? Math.ceil((placedCount + finalUnplaced.length) / placedCount)
    : (finalUnplaced.length > 0 ? Infinity : 1);

  return { placed: finalResults, unplaced: finalUnplaced, efficiency: efficiency, lossArea: lossArea, sheetsNeeded: sheetsNeeded };
}

self.onmessage = function(e) {
  var polygons = e.data.polygons;
  var sheetConfig = e.data.sheetConfig;
  try {
    var result = nest(polygons, sheetConfig);
    self.postMessage({ type: 'result', placed: result.placed, unplaced: result.unplaced, efficiency: result.efficiency, lossArea: result.lossArea, sheetsNeeded: result.sheetsNeeded });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
