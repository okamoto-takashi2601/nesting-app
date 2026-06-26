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

  // Step 3: vertex is hard if NOT BOTH adjacent edges are chamfers AND angle sin >= 0.15 (≈8.6°).
  // Using && (not ||) so that straight-to-arc junctions (one chamfer neighbour) still qualify.
  var vertexHard = new Array(n);
  for (var i = 0; i < n; i++) {
    if (isChamfer[(i - 1 + n) % n] && isChamfer[i]) { vertexHard[i] = false; continue; }
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

  // Step 4: edge is flush-eligible only if not a chamfer AND both endpoints are hard corners.
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

// Edge-aware SAT: gap = 0 only when both shapes are all-straight (flush allowed).
// If either shape has any curved edge, configSpacing is enforced on all axes.
function satOverlapAware(a, aEdgeStr, b, bEdgeStr, configSpacing) {
  var n, i, j, edge, axis, projA, projB, gap;

  var bHasCurved = false;
  for (i = 0; i < bEdgeStr.length; i++) { if (!bEdgeStr[i]) { bHasCurved = true; break; } }
  var aHasCurved = false;
  for (i = 0; i < aEdgeStr.length; i++) { if (!aEdgeStr[i]) { aHasCurved = true; break; } }

  n = a.length;
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    edge = { x: a[j].x - a[i].x, y: a[j].y - a[i].y };
    axis = normalize({ x: -edge.y, y: edge.x });
    projA = project(a, axis);
    projB = project(b, axis);
    gap = (aEdgeStr[i] && !bHasCurved) ? 0 : configSpacing;
    if (projA[1] + gap <= projB[0] || projB[1] + gap <= projA[0]) return false;
  }

  n = b.length;
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    edge = { x: b[j].x - b[i].x, y: b[j].y - b[i].y };
    axis = normalize({ x: -edge.y, y: edge.x });
    projA = project(a, axis);
    projB = project(b, axis);
    gap = (bEdgeStr[i] && !aHasCurved) ? 0 : configSpacing;
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

// Binary-search the minimum X translation so that translate(ptsB, tx, 0) no longer overlaps ptsA.
// Both ptsA and ptsB must already be normalised (minX=0, minY=0).
function minStepX(ptsA, esA, ptsB, esB, configSpacing) {
  var bA = getBounds(ptsA);
  var hi = bA.maxX + getBounds(ptsB).maxX + configSpacing + 1;
  var lo = 0;
  for (var i = 0; i < 32; i++) {
    var mid = (lo + hi) / 2;
    if (satOverlapAware(ptsA, esA, translate(ptsB, mid, 0), esB, configSpacing)) lo = mid;
    else hi = mid;
  }
  return Math.max(hi, bA.maxX - bA.minX);
}

// Binary-search the minimum Y translation so that translate(ptsB, 0, ty) no longer overlaps ptsA.
function minStepY(ptsA, esA, ptsB, esB, configSpacing) {
  var bA = getBounds(ptsA);
  var hi = bA.maxY + getBounds(ptsB).maxY + configSpacing + 1;
  var lo = 0;
  for (var i = 0; i < 32; i++) {
    var mid = (lo + hi) / 2;
    if (satOverlapAware(ptsA, esA, translate(ptsB, 0, mid), esB, configSpacing)) lo = mid;
    else hi = mid;
  }
  return Math.max(hi, bA.maxY - bA.minY);
}

// Like minStepY but ptsB is pre-shifted by ox in X (for chidori row-offset checks).
function minStepYWithOffset(ptsA, esA, ptsB, esB, ox, configSpacing) {
  var bA = getBounds(ptsA);
  var shifted = translate(ptsB, ox, 0);
  var hi = bA.maxY + getBounds(ptsB).maxY + configSpacing + 1;
  var lo = 0;
  for (var i = 0; i < 32; i++) {
    var mid = (lo + hi) / 2;
    if (satOverlapAware(ptsA, esA, translate(shifted, 0, mid), esB, configSpacing)) lo = mid;
    else hi = mid;
  }
  return Math.max(hi, bA.maxY - bA.minY);
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

  var myHasCurved = false;
  for (var mci = 0; mci < myEdgeStr.length; mci++) { if (!myEdgeStr[mci]) { myHasCurved = true; break; } }

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

    var pHasCurved = false;
    for (var pci = 0; pci < pEdgeStr.length; pci++) { if (!pEdgeStr[pci]) { pHasCurved = true; break; } }

    // AABB-edge candidates: always try both flush and spacing gaps so overlapsAny can filter.
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
      var edgeGap = (pEdgeStr[ei] && !myHasCurved) ? 0 : configSpacing;

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
        var newEdgeGap = (myEdgeStr[nei] && !pHasCurved) ? 0 : configSpacing;

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
// Prefers rotations that put a straight edge on the RIGHT or large-Y face (visual bottom).
// Counts rows using alternating rot/rot+180 logic to match nestSame.
function pickSameRotation(sortedPolygons, candidateRots, sw, sh, spacing, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var bestRot = candidateRots[0];
  var bestScore = -1;

  for (var ri = 0; ri < candidateRots.length; ri++) {
    var rot0 = candidateRots[ri];
    var poly0 = sortedPolygons[0];

    var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(p0); p0 = translate(p0, -b0.minX, -b0.minY);
    var w0 = getBounds(p0).maxX, h0 = getBounds(p0).maxY;
    if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) continue;

    var es = poly0.edgeStr;
    var stepX = minStepX(p0, es, p0, es, spacing);
    var stepY = minStepY(p0, es, p0, es, spacing);

    var perRow = w0 <= sw - 2 * MARGIN + tol ? 1 + Math.floor((sw - 2 * MARGIN - w0) / stepX) : 0;
    if (perRow < 1) continue;

    var rows = 0, y = MARGIN;
    while (true) {
      if (y + h0 + MARGIN > sh + tol) break;
      rows++;
      y += stepY;
    }
    if (rows < 1) continue;

    var bonus = (hasStraightOnFace(p0, es, 'top') || hasStraightOnFace(p0, es, 'right')) ? 1 : 0;
    var score = perRow * rows * 10 + bonus;
    if (score > bestScore) { bestScore = score; bestRot = rot0; }
  }
  return bestRot;
}

// Back-to-back rotation picker.
// Priority: find a flush-eligible edge, compute exact rotation that puts it on the right face,
// then pick the best among those exact rotations (by piece count).
// Falls back to COARSE_ROTS scoring only when no flush-eligible edges exist.
function pickBackBackRotation(sortedPolygons, candidateRots, sw, sh, spacing, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var poly0 = sortedPolygons[0];
  var pts0 = poly0.points, es0 = poly0.edgeStr, n0 = pts0.length;

  // Compute exact rotations from flush-eligible edges.
  // For edge i with direction (dx, dy), atan2(dx, dy) rotates that vector to point straight down (+y).
  // After rotation the edge becomes vertical and lands on the right face (maxX) for a CW-screen polygon.
  var exactRots = [];
  for (var ei = 0; ei < n0; ei++) {
    if (!es0[ei]) continue;
    var ej = (ei + 1) % n0;
    var edx = pts0[ej].x - pts0[ei].x, edy = pts0[ej].y - pts0[ei].y;
    var deg = ((Math.atan2(edx, edy) * 180 / Math.PI) % 360 + 360) % 360;
    exactRots.push(+deg.toFixed(2));
    exactRots.push(+((deg + 180) % 360).toFixed(2));
  }

  var candidates = exactRots.length > 0 ? exactRots : candidateRots;

  function score(rot0) {
    var rot1 = (rot0 + 180) % 360;
    var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(p0); p0 = translate(p0, -b0.minX, -b0.minY);
    var w0 = getBounds(p0).maxX, h0 = getBounds(p0).maxY;
    if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) return -1;
    var p1 = rot1 !== 0 ? rotatePoints(poly0.points, rot1) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b1 = getBounds(p1); p1 = translate(p1, -b1.minX, -b1.minY);
    var w1 = getBounds(p1).maxX, h1 = getBounds(p1).maxY;
    var es = poly0.edgeStr;
    var stepR0R1 = minStepX(p0, es, p1, es, spacing);
    var stepR1R0 = minStepX(p1, es, p0, es, spacing);
    var stepY    = minStepY(p0, es, p0, es, spacing);
    var rowH    = Math.max(h0, h1);
    var perRow = 0, cx = MARGIN, si = 0;
    while (true) {
      var cw = (si % 2 === 0) ? w0 : w1;
      if (cx + cw + MARGIN > sw + tol) break;
      perRow++;
      cx += (si % 2 === 0) ? stepR0R1 : stepR1R0;
      si++;
    }
    if (perRow < 1) return -1;
    var rows = 0, cy = MARGIN;
    while (cy + rowH + MARGIN <= sh + tol) { rows++; cy += stepY; }
    if (rows < 1) return -1;
    return perRow * rows;
  }

  var bestRot = candidates[0], bestScore = -1;
  for (var ri = 0; ri < candidates.length; ri++) {
    var s = score(candidates[ri]);
    if (s > bestScore) { bestScore = s; bestRot = candidates[ri]; }
  }
  return bestRot;
}

// Back-to-back layout:
//   Row pattern (left→right): rot0, rot1, rot0, rot1, …
//   gap between rot0→rot1: 0 if right face of rot0 AND left face of rot1 are both straight.
//   gap between rot1→rot0: 0 if right face of rot1 AND left face of rot0 are both straight.
//   Rows repeat the same pattern downward.
//   gap_y: 0 if bottom face (maxY) of every piece AND top face (minY) of every piece are straight.
function nestBackBack(sorted, sw, sh, spacing, uniformRot, boundary, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var results = [];
  var unplaced = [];
  if (sorted.length === 0) return { results: results, unplaced: unplaced };

  var rot0 = uniformRot !== null ? uniformRot : 0;
  var rot1 = (rot0 + 180) % 360;

  var poly0 = sorted[0];
  var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
  var b0r = getBounds(p0); p0 = translate(p0, -b0r.minX, -b0r.minY);
  var w0 = getBounds(p0).maxX, h0 = getBounds(p0).maxY;

  var p1 = rot1 !== 0 ? rotatePoints(poly0.points, rot1) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
  var b1r = getBounds(p1); p1 = translate(p1, -b1r.minX, -b1r.minY);
  var w1 = getBounds(p1).maxX, h1 = getBounds(p1).maxY;

  if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var es = poly0.edgeStr;
  var stepR0R1 = minStepX(p0, es, p1, es, spacing);
  var stepR1R0 = minStepX(p1, es, p0, es, spacing);
  var stepY    = minStepY(p0, es, p0, es, spacing);
  var rowH    = Math.max(h0, h1);

  // Build row slot template: alternating rot0 / rot1 with geometry-exact steps
  var rowSlots = [];
  var x = MARGIN, sIdx = 0;
  while (true) {
    var isEven = (sIdx % 2 === 0);
    var cw = isEven ? w0 : w1;
    if (x + cw + MARGIN > sw + tol) break;
    rowSlots.push({ x: x, rot: isEven ? rot0 : rot1 });
    x += isEven ? stepR0R1 : stepR1R0;
    sIdx++;
  }

  if (rowSlots.length === 0) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var pi = 0;
  var rowY = MARGIN;

  while (pi < sorted.length) {
    if (rowY + rowH + MARGIN > sh + tol) break;

    for (var slot = 0; slot < rowSlots.length && pi < sorted.length; slot++) {
      var poly = sorted[pi];
      var curRot = rowSlots[slot].rot;
      var pts = curRot !== 0 ? rotatePoints(poly.points, curRot) : poly.points.map(function(p) { return { x: p.x, y: p.y }; });
      var b = getBounds(pts);
      pts = translate(pts, -b.minX, -b.minY);
      var tx = rowSlots[slot].x;
      var moved = translate(pts, tx, rowY);
      var holes = transformHoles(poly.holes, curRot, -b.minX, -b.minY, tx, rowY);
      results.push({ id: poly.id, label: poly.label, points: moved, holes: holes, rotation: curRot, color: poly.color });
      pi++;
    }

    rowY += stepY;
  }

  self.postMessage({ type: 'progress', placed: results, current: pi, total: sorted.length });
  for (var j = pi; j < sorted.length; j++) unplaced.push(sorted[j].id);
  return { results: results, unplaced: unplaced };
}

// Same-direction layout: all pieces at the same rotation (uniformRot).
// Gap between pieces (H): 0 if both left and right faces are straight, else spacing.
// Gap between rows: 0 if both top and bottom faces are straight, else spacing.
function nestSame(sorted, sw, sh, spacing, uniformRot, boundary, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var results = [];
  var unplaced = [];
  if (sorted.length === 0) return { results: results, unplaced: unplaced };

  var rot0 = uniformRot !== null ? uniformRot : 0;

  var poly0 = sorted[0];
  var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
  var b0r = getBounds(p0); p0 = translate(p0, -b0r.minX, -b0r.minY);
  var w0 = getBounds(p0).maxX, h0 = getBounds(p0).maxY;

  if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var es = poly0.edgeStr;
  var stepX = minStepX(p0, es, p0, es, spacing);
  var stepY = minStepY(p0, es, p0, es, spacing);

  var rowSlots = [];
  var curX = MARGIN;
  while (curX + w0 + MARGIN <= sw + tol) {
    rowSlots.push(curX);
    curX += stepX;
  }

  if (rowSlots.length === 0) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var perRow = rowSlots.length;
  var pi = 0;
  var rowY = MARGIN;

  while (pi < sorted.length) {
    if (rowY + h0 + MARGIN > sh + tol) break;

    for (var slot = 0; slot < perRow && pi < sorted.length; slot++) {
      var poly = sorted[pi];
      var pts = rot0 !== 0 ? rotatePoints(poly.points, rot0) : poly.points.map(function(p) { return { x: p.x, y: p.y }; });
      var b0 = getBounds(pts);
      pts = translate(pts, -b0.minX, -b0.minY);
      var tx = rowSlots[slot];
      var ty = rowY;
      var moved = translate(pts, tx, ty);
      var holes = transformHoles(poly.holes, rot0, -b0.minX, -b0.minY, tx, ty);
      results.push({ id: poly.id, label: poly.label, points: moved, holes: holes, rotation: rot0, color: poly.color });
      pi++;
    }

    rowY += stepY;
  }

  self.postMessage({ type: 'progress', placed: results, current: pi, total: sorted.length });
  for (var j = pi; j < sorted.length; j++) unplaced.push(sorted[j].id);
  return { results: results, unplaced: unplaced };
}

// Chidori-only structured layout (chidori60 / chidori30).
function nestStructured(sorted, sw, sh, spacing, layoutMode, uniformRot, initPlaced, initBounds, initEdgeStr, boundary, margin) {
  var MARGIN = (typeof margin === 'number' && !boundary) ? margin : 0;
  var esw = sw - 2 * MARGIN;
  var esh = sh - 2 * MARGIN;
  var results = [];
  var placed = MARGIN > 0
    ? initPlaced.map(function(pts) { return translate(pts, -MARGIN, -MARGIN); })
    : initPlaced.slice();
  var placedBounds = placed.map(getBounds);
  var placedEdgeStr = initEdgeStr.slice();
  var unplaced = [];
  var tol = 0.001;

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
    if (pw + 2 * spacing <= esw) {
      cellPitch = minStepX(pp0n, sorted[pi].edgeStr, pp0n, sorted[pi].edgeStr, spacing);
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

    if (w + 2 * spacing > esw || h + 2 * spacing > esh) {
      unplaced.push(poly.id); continue;
    }

    if (shelfX + w + spacing > esw + tol) {
      shelfIdx++;
      shelfX = spacing + (shelfIdx % 2 === 1 ? cellPitch / 2 : 0);
      if (shelfX + w + spacing > esw + tol) {
        shelfIdx++;
        shelfX = spacing + (shelfIdx % 2 === 1 ? cellPitch / 2 : 0);
      }
    }

    var y = dropY(pts, shelfX, placed, placedBounds, placedEdgeStr, esh, spacing, myEdgeStrC);
    if (y === null) { unplaced.push(poly.id); continue; }

    var moved = translate(pts, shelfX, y);
    var mb = getBounds(moved);

    if (boundary && !isFullyInsideBoundary(moved, boundary)) {
      unplaced.push(poly.id);
      continue;
    }

    if (mb.maxY > esh + tol || overlapsAny(moved, myEdgeStrC, placed, placedBounds, placedEdgeStr, spacing)) {
      unplaced.push(poly.id);
    } else {
      placed.push(moved); placedBounds.push(mb); placedEdgeStr.push(myEdgeStrC);
      var holesC = transformHoles(poly.holes, rot, -b0.minX, -b0.minY, shelfX, y);
      var finalMovedC = MARGIN > 0 ? translate(moved, MARGIN, MARGIN) : moved;
      var finalHolesC = (MARGIN > 0 && holesC) ? holesC.map(function(h) { return translate(h, MARGIN, MARGIN); }) : holesC;
      results.push({ id: poly.id, label: poly.label, points: finalMovedC, holes: finalHolesC, rotation: rot, color: poly.color });
      shelfX += cellPitch;
    }

    if ((si + 1) % 3 === 0 || si === sorted.length - 1) {
      self.postMessage({ type: 'progress', placed: results, current: si + 1, total: sorted.length });
    }
  }

  return { results: results, unplaced: unplaced };
}

// Exact polygon overlap: AABB pre-reject, then vertex-in-polygon + edge intersection.
// Handles concave polygons correctly (unlike SAT which gives false negatives).
function polygonsOverlap(a, b) {
  var ba = getBounds(a), bb = getBounds(b);
  if (ba.maxX <= bb.minX || bb.maxX <= ba.minX || ba.maxY <= bb.minY || bb.maxY <= ba.minY) return false;
  var an = a.length, bn = b.length, i, ai, bi;
  for (i = 0; i < an; i++) {
    if (pointInPolygon(a[i].x, a[i].y, b)) return true;
  }
  for (i = 0; i < bn; i++) {
    if (pointInPolygon(b[i].x, b[i].y, a)) return true;
  }
  for (ai = 0; ai < an; ai++) {
    var a1 = a[ai], a2 = a[(ai + 1) % an];
    for (bi = 0; bi < bn; bi++) {
      var b1 = b[bi], b2 = b[(bi + 1) % bn];
      if (segmentsIntersect(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)) return true;
    }
  }
  return false;
}

// Find minimum shift (direction dx/dy) where two identical copies just separate.
// Uses exact polygon overlap (not SAT) → correct for concave interlocking shapes.
// Returns the contact pitch + spacing.
function findInterlockPitch(pts0, edgeStr, spacing, dx, dy) {
  var b0 = getBounds(pts0);
  var range = Math.abs(dx) > 0.5 ? b0.maxX : b0.maxY;
  var lo = 0.5;
  var hi = range;
  if (!polygonsOverlap(pts0, translate(pts0, dx * lo, dy * lo))) return spacing;
  while (hi - lo > 0.1) {
    var mid = (lo + hi) / 2;
    var shifted = translate(pts0, dx * mid, dy * mid);
    if (polygonsOverlap(pts0, shifted)) lo = mid;
    else hi = mid;
  }
  return hi + spacing;
}

function pickInterlockRotation(sortedPolygons, candidateRots, sw, sh, spacing, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var poly0 = sortedPolygons[0];
  var pts0 = poly0.points;
  var n0 = pts0.length;

  // Detect long straight edges (not arc tessellation segments).
  // Arc tessellation produces many short chords; true straight LINE entities
  // span a significant fraction of the bounding-box diagonal.
  // For each long edge compute the rotation that makes it horizontal:
  //   atan2(-edy, edx) so that after rotation new_edy = 0.
  var b0raw = getBounds(pts0);
  var bboxDiag = Math.sqrt(
    (b0raw.maxX - b0raw.minX) * (b0raw.maxX - b0raw.minX) +
    (b0raw.maxY - b0raw.minY) * (b0raw.maxY - b0raw.minY)
  );
  var lengthThresh = bboxDiag * 0.2;

  var exactRots = [], seenRots = {};
  for (var ei = 0; ei < n0; ei++) {
    var ej = (ei + 1) % n0;
    var edx = pts0[ej].x - pts0[ei].x;
    var edy = pts0[ej].y - pts0[ei].y;
    var edgeLen = Math.sqrt(edx * edx + edy * edy);
    if (edgeLen < lengthThresh) continue;
    var deg = ((Math.atan2(-edy, edx) * 180 / Math.PI) % 360 + 360) % 360;
    [deg, (deg + 90) % 360, (deg + 180) % 360, (deg + 270) % 360].forEach(function(r) {
      var key = Math.round(r * 10);
      if (!seenRots[key]) { seenRots[key] = true; exactRots.push(+r.toFixed(1)); }
    });
  }

  var candidates = exactRots.length > 0 ? exactRots : candidateRots;

  var bestRot = candidates[0], bestScore = -1, bestArea = Infinity;
  for (var ri = 0; ri < candidates.length; ri++) {
    var rot0 = candidates[ri];
    var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
    var b0 = getBounds(p0); p0 = translate(p0, -b0.minX, -b0.minY);
    var b = getBounds(p0);
    var w0 = b.maxX, h0 = b.maxY;
    if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) continue;
    var pitchX = findInterlockPitch(p0, null, spacing, 1, 0);
    var pitchY = findInterlockPitch(p0, null, spacing, 0, 1);
    if (pitchX <= 0 || pitchY <= 0) continue;
    var perRow = Math.floor((sw - 2 * MARGIN - w0) / pitchX) + 1;
    var rows = Math.floor((sh - 2 * MARGIN - h0) / pitchY) + 1;
    if (perRow < 1 || rows < 1) continue;
    var score = perRow * rows;
    var area = pitchX * pitchY;
    if (score > bestScore || (score === bestScore && area < bestArea)) {
      bestScore = score;
      bestArea = area;
      bestRot = rot0;
    }
  }
  return bestRot;
}

// Interlock layout: find minimum x-pitch and y-pitch by binary search (exact polygon overlap),
// then tile parts in straight rows at those pitches (bounding boxes may overlap).
function nestInterlock(sorted, sw, sh, spacing, uniformRot, boundary, margin) {
  var MARGIN = typeof margin === 'number' ? margin : 5;
  var tol = 0.001;
  var results = [];
  var unplaced = [];
  if (sorted.length === 0) return { results: results, unplaced: unplaced };

  var rot0 = uniformRot !== null ? uniformRot : 0;
  var poly0 = sorted[0];
  var p0 = rot0 !== 0 ? rotatePoints(poly0.points, rot0) : poly0.points.map(function(p) { return { x: p.x, y: p.y }; });
  var b0r = getBounds(p0); p0 = translate(p0, -b0r.minX, -b0r.minY);
  var b0 = getBounds(p0);
  var w0 = b0.maxX, h0 = b0.maxY;
  var es0 = poly0.edgeStr;

  if (w0 > sw - 2 * MARGIN + tol || h0 > sh - 2 * MARGIN + tol) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var pitchX = findInterlockPitch(p0, es0, spacing, 1, 0);
  var pitchY = findInterlockPitch(p0, es0, spacing, 0, 1);

  var rowSlots = [];
  var x = MARGIN;
  while (x + w0 <= sw - MARGIN + tol) {
    rowSlots.push(x);
    x += pitchX;
  }

  if (rowSlots.length === 0) {
    for (var i = 0; i < sorted.length; i++) unplaced.push(sorted[i].id);
    return { results: results, unplaced: unplaced };
  }

  var pi = 0;
  var rowY = MARGIN;

  while (pi < sorted.length && rowY + h0 <= sh - MARGIN + tol) {
    for (var slot = 0; slot < rowSlots.length && pi < sorted.length; slot++) {
      var poly = sorted[pi];
      var pts = rot0 !== 0 ? rotatePoints(poly.points, rot0) : poly.points.map(function(p) { return { x: p.x, y: p.y }; });
      var b = getBounds(pts); pts = translate(pts, -b.minX, -b.minY);
      var tx = rowSlots[slot];
      var ty = rowY;
      var moved = translate(pts, tx, ty);
      var holes = transformHoles(poly.holes, rot0, -b.minX, -b.minY, tx, ty);
      results.push({ id: poly.id, label: poly.label, points: moved, holes: holes, rotation: rot0, color: poly.color });
      pi++;
    }
    rowY += pitchY;
  }

  self.postMessage({ type: 'progress', placed: results, current: pi, total: sorted.length });
  for (var j = pi; j < sorted.length; j++) unplaced.push(sorted[j].id);
  return { results: results, unplaced: unplaced };
}

// Set-aware free nesting: place complete sets first, then fill gaps with individual parts.
// sanitizedPolygons must be pre-ordered in set groups: [A,A,B, A,A,B, ...] (setSize items per group).
function nestFreeWithSets(sanitizedPolygons, setSize, sw, sh, spacing, margin, boundary, initPlaced, initBounds, initEdgeStr) {
  var MARGIN_FREE = (typeof margin === 'number' && !boundary) ? margin : 0;
  var esw = sw - 2 * MARGIN_FREE;
  var esh = sh - 2 * MARGIN_FREE;
  var MAX_SRC = 50;
  var totalPolys = sanitizedPolygons.length;

  var placed = MARGIN_FREE > 0
    ? initPlaced.map(function(pts) { return translate(pts, -MARGIN_FREE, -MARGIN_FREE); })
    : initPlaced.slice();
  var placedBounds = placed.map(getBounds);
  var placedEdgeStr = initEdgeStr.slice();
  var results = [];

  var fitPoly = function(poly) {
    var srcStart = Math.max(0, placed.length - MAX_SRC);
    var coarse = tryRotations(poly.points, poly.edgeStr, COARSE_ROTS, placed, placedBounds, placedEdgeStr, srcStart, esw, esh, spacing, boundary);
    if (!coarse) return null;
    var fineRots = [];
    for (var da = -14; da <= 14; da++) {
      if (da !== 0) fineRots.push(((coarse.rot + da) % 360 + 360) % 360);
    }
    var fine = tryRotations(poly.points, poly.edgeStr, fineRots, placed, placedBounds, placedEdgeStr, srcStart, esw, esh, spacing, boundary);
    return (fine && fine.score < coarse.score) ? fine : coarse;
  };

  var commitResult = function(poly, best) {
    placed.push(best.pts);
    placedBounds.push(getBounds(best.pts));
    placedEdgeStr.push(poly.edgeStr);
    var bestHoles;
    if (poly.holes && poly.holes.length) {
      var outerRot = best.rot !== 0 ? rotatePoints(poly.points, best.rot) : poly.points;
      var outerB = getBounds(outerRot);
      var bestB = getBounds(best.pts);
      bestHoles = transformHoles(poly.holes, best.rot, -outerB.minX, -outerB.minY, bestB.minX, bestB.minY);
    }
    var finalPts = MARGIN_FREE > 0 ? translate(best.pts, MARGIN_FREE, MARGIN_FREE) : best.pts;
    var finalHoles = (MARGIN_FREE > 0 && bestHoles) ? bestHoles.map(function(h) { return translate(h, MARGIN_FREE, MARGIN_FREE); }) : bestHoles;
    results.push({ id: poly.id, label: poly.label, points: finalPts, holes: finalHoles, rotation: best.rot, color: poly.color });
  };

  // Phase 1: place complete sets; stop at first set that cannot fully fit.
  var fillStart = 0;
  var i = 0;
  while (i + setSize <= totalPolys) {
    var setPolys = sanitizedPolygons.slice(i, i + setSize);
    var cpPlaced = placed.slice();
    var cpBounds = placedBounds.slice();
    var cpEdgeStr = placedEdgeStr.slice();
    var cpLen = results.length;
    var setOk = true;

    for (var si = 0; si < setPolys.length; si++) {
      var best = fitPoly(setPolys[si]);
      if (best) {
        commitResult(setPolys[si], best);
      } else {
        setOk = false;
        break;
      }
    }

    if (setOk) {
      i += setSize;
      fillStart = i;
      if (i % (setSize * 4) === 0) {
        self.postMessage({ type: 'progress', placed: results, current: i, total: totalPolys });
      }
    } else {
      // Restore checkpoint and stop set phase
      placed = cpPlaced;
      placedBounds = cpBounds;
      placedEdgeStr = cpEdgeStr;
      results.length = cpLen;
      break;
    }
  }

  self.postMessage({ type: 'progress', placed: results, current: fillStart, total: totalPolys });

  // Phase 2: fill remaining space with individual parts (area-descending).
  var remaining = sanitizedPolygons.slice(fillStart);
  remaining.sort(function(a, b) { return polygonArea(b.points) - polygonArea(a.points); });
  var unplaced = [];

  for (var fi = 0; fi < remaining.length; fi++) {
    var best = fitPoly(remaining[fi]);
    if (best) {
      commitResult(remaining[fi], best);
    } else {
      unplaced.push(remaining[fi].id);
    }
    if ((fi + 1) % 5 === 0 || fi === remaining.length - 1) {
      self.postMessage({ type: 'progress', placed: results, current: fillStart + fi + 1, total: totalPolys });
    }
  }

  return { results: results, unplaced: unplaced };
}

function nest(polygons, sheetConfig, lockedParts, setSize) {
  setSize = setSize || 0;
  var sw = sheetConfig.width;
  var sh = sheetConfig.height;
  var spacing = sheetConfig.spacing || 0;
  var margin = typeof sheetConfig.margin === 'number' ? sheetConfig.margin : 5;
  var layoutMode = sheetConfig.layoutMode || 'free';
  var MAX_SRC = 50;

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

  // For structured (tiling) modes: pre-expand sorted so the sheet is fully filled.
  // Each nest function loops while (pi < sorted.length), so we need enough copies.
  var origSortedLen = sorted.length;
  var STRUCTURED_MODES = ['same', 'back-back', 'square', 'chidori30', 'chidori60', 'interlock'];
  if (STRUCTURED_MODES.indexOf(layoutMode) >= 0 && sorted.length > 0 && (lockedParts || []).length === 0) {
    var minW = Infinity, minH = Infinity;
    for (var _ei = 0; _ei < sorted.length; _ei++) {
      var _b = getBounds(sorted[_ei].points);
      var _bw = _b.maxX - _b.minX, _bh = _b.maxY - _b.minY;
      if (_bw > 0 && _bw < minW) minW = _bw;
      if (_bh > 0 && _bh < minH) minH = _bh;
    }
    var estCap = Math.ceil(sw / minW) * Math.ceil(sh / minH) + origSortedLen;
    var _origLen = sorted.length;
    while (sorted.length < estCap) {
      for (var _ci = 0; _ci < _origLen && sorted.length < estCap; _ci++) {
        var _src = sorted[_ci];
        sorted.push({ id: _src.id + '_t' + sorted.length, label: _src.label, color: _src.color, points: _src.points, holes: _src.holes, edgeStr: _src.edgeStr });
      }
    }
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
  var lockedList = lockedParts || [];
  for (var li = 0; li < lockedList.length; li++) {
    var lpts = sanitizePoints(lockedList[li].points);
    if (!lpts || lpts.length < 3) continue;
    initPlaced.push(lpts);
    initBounds.push(getBounds(lpts));
    initEdgeStr.push(computeEdgeStraight(lpts));
  }
  var hasLocked = lockedList.length > 0;

  var uniformRot = null;
  if (layoutMode === 'chidori60') {
    uniformRot = pickBestUniformRotation(sorted, CHIDORI60_ROTS, sw, sh, spacing, boundary);
  } else if (layoutMode === 'chidori30') {
    uniformRot = pickBestUniformRotation(sorted, CHIDORI30_ROTS, sw, sh, spacing, boundary);
  } else if (layoutMode === 'same') {
    uniformRot = pickSameRotation(sorted, COARSE_ROTS, sw, sh, spacing, margin);
  } else if (layoutMode === 'back-back') {
    uniformRot = pickBackBackRotation(sorted, COARSE_ROTS, sw, sh, spacing, margin);
  } else if (layoutMode === 'interlock') {
    uniformRot = pickInterlockRotation(sorted, makeRotations(30), sw, sh, spacing, margin);
  } else if (layoutMode === 'square') {
    uniformRot = 0;
  }

  var finalResults, finalUnplaced;

  if (layoutMode === 'same' && !hasLocked) {
    var out = nestSame(sorted, sw, sh, spacing, uniformRot, boundary, margin);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else if (layoutMode === 'square' && !hasLocked) {
    // Square = aligned grid, no rotation — reuses nestSame with forced rot=0
    var out = nestSame(sorted, sw, sh, spacing, 0, boundary, margin);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else if (layoutMode === 'back-back' && !hasLocked) {
    var out = nestBackBack(sorted, sw, sh, spacing, uniformRot, boundary, margin);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else if (layoutMode === 'interlock' && !hasLocked) {
    var out = nestInterlock(sorted, sw, sh, spacing, uniformRot, boundary, margin);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else if (layoutMode !== 'free' && !hasLocked) {
    var out = nestStructured(sorted, sw, sh, spacing, layoutMode, uniformRot, initPlaced, initBounds, initEdgeStr, boundary, margin);
    finalResults = out.results;
    finalUnplaced = out.unplaced;
  } else {
    // Hybrid free rotation:
    // 1) Try all 4 structured modes, pick the one that places the most shapes.
    // 2) Fill remaining gaps with unconstrained rotation (SAT-based).
    var MARGIN_FREE = (typeof margin === 'number' && !boundary) ? margin : 0;
    var esw_free = sw - 2 * MARGIN_FREE;
    var esh_free = sh - 2 * MARGIN_FREE;

    var uniqueLabels = {};
    for (var ulF = 0; ulF < sorted.length; ulF++) uniqueLabels[sorted[ulF].label] = true;
    var mixedParts = Object.keys(uniqueLabels).length > 1;

    if (setSize > 1 && !hasLocked) {
      var setOut = nestFreeWithSets(sanitized, setSize, sw, sh, spacing, margin, boundary, initPlaced, initBounds, initEdgeStr);
      finalResults = setOut.results;
      finalUnplaced = setOut.unplaced;
    } else {

    var bestStructF;
    if (!hasLocked && !mixedParts) {
      var rotSameF = pickSameRotation(sorted, COARSE_ROTS, sw, sh, spacing, margin);
      var outSameF = nestSame(sorted, sw, sh, spacing, rotSameF, boundary, margin);

      var rotBBF = pickBackBackRotation(sorted, COARSE_ROTS, sw, sh, spacing, margin);
      var outBBF = nestBackBack(sorted, sw, sh, spacing, rotBBF, boundary, margin);

      var rotC30F = pickBestUniformRotation(sorted, CHIDORI30_ROTS, sw, sh, spacing, boundary);
      var outC30F = nestStructured(sorted, sw, sh, spacing, 'chidori30', rotC30F, initPlaced, initBounds, initEdgeStr, boundary, margin);

      var rotC60F = pickBestUniformRotation(sorted, CHIDORI60_ROTS, sw, sh, spacing, boundary);
      var outC60F = nestStructured(sorted, sw, sh, spacing, 'chidori60', rotC60F, initPlaced, initBounds, initEdgeStr, boundary, margin);

      var structOutsF = [outSameF, outBBF, outC30F, outC60F];
      bestStructF = structOutsF[0];
      for (var sciF = 1; sciF < structOutsF.length; sciF++) {
        if (structOutsF[sciF].results.length > bestStructF.results.length) bestStructF = structOutsF[sciF];
      }
    } else {
      bestStructF = { results: [], unplaced: sorted.map(function(s) { return s.id; }) };
    }

    // Build id→poly lookup for edgeStr
    var idPolyF = {};
    for (var ipF = 0; ipF < sorted.length; ipF++) idPolyF[sorted[ipF].id] = sorted[ipF];

    // Build placed list from obstacles + best structured results (in free-rotation coords)
    var placed = MARGIN_FREE > 0
      ? initPlaced.map(function(pts) { return translate(pts, -MARGIN_FREE, -MARGIN_FREE); })
      : initPlaced.slice();
    var placedBounds = placed.map(getBounds);
    var placedEdgeStr = initEdgeStr.slice();

    for (var rfF = 0; rfF < bestStructF.results.length; rfF++) {
      var rrF = bestStructF.results[rfF];
      var rPtsF = MARGIN_FREE > 0 ? translate(rrF.points, -MARGIN_FREE, -MARGIN_FREE) : rrF.points;
      placed.push(rPtsF);
      placedBounds.push(getBounds(rPtsF));
      var rPolyF = idPolyF[rrF.id];
      placedEdgeStr.push(rPolyF ? rPolyF.edgeStr : []);
    }

    var results = bestStructF.results.slice();
    var unplaced = [];

    // Collect unplaced shapes preserving sorted order
    var unplacedSetF = {};
    for (var uiF = 0; uiF < bestStructF.unplaced.length; uiF++) unplacedSetF[bestStructF.unplaced[uiF]] = true;
    var unplacedShapesF = [];
    for (var siF0 = 0; siF0 < sorted.length; siF0++) {
      if (unplacedSetF[sorted[siF0].id]) unplacedShapesF.push(sorted[siF0]);
    }

    if (bestStructF.results.length > 0) {
      self.postMessage({ type: 'progress', placed: results, current: bestStructF.results.length, total: sorted.length });
    }

    // Fill remaining space with free rotation
    for (var siF = 0; siF < unplacedShapesF.length; siF++) {
      var poly = unplacedShapesF[siF];
      var myEdgeStr = poly.edgeStr;
      var srcStart = Math.max(0, placed.length - MAX_SRC);

      var coarse = tryRotations(poly.points, myEdgeStr, COARSE_ROTS, placed, placedBounds, placedEdgeStr, srcStart, esw_free, esh_free, spacing, boundary);
      var best = coarse;
      if (coarse !== null) {
        var center = coarse.rot;
        var fineRots = [];
        for (var da = -14; da <= 14; da++) {
          if (da === 0) continue;
          fineRots.push(((center + da) % 360 + 360) % 360);
        }
        var fine = tryRotations(poly.points, myEdgeStr, fineRots, placed, placedBounds, placedEdgeStr, srcStart, esw_free, esh_free, spacing, boundary);
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
        var finalPtsFree = MARGIN_FREE > 0 ? translate(best.pts, MARGIN_FREE, MARGIN_FREE) : best.pts;
        var finalHolesFree = (MARGIN_FREE > 0 && bestHoles) ? bestHoles.map(function(h) { return translate(h, MARGIN_FREE, MARGIN_FREE); }) : bestHoles;
        results.push({ id: poly.id, label: poly.label, points: finalPtsFree, holes: finalHolesFree, rotation: best.rot, color: poly.color });
      } else {
        unplaced.push(poly.id);
      }

      if ((siF + 1) % 3 === 0 || siF === unplacedShapesF.length - 1) {
        self.postMessage({ type: 'progress', placed: results, current: bestStructF.results.length + siF + 1, total: sorted.length });
      }
    }

    finalResults = results;
    finalUnplaced = unplaced;
    } // end else (non-set free mode)
  }

  // Use boundary area for efficiency when boundary polygon is defined
  var sheetArea = boundary ? polygonArea(boundary) : sw * sh;
  var partsArea = finalResults.reduce(function(sum, r) { return sum + polygonArea(r.points); }, 0);
  var efficiency = sheetArea > 0 ? Math.round((partsArea / sheetArea) * 100) : 0;
  var lossArea = Math.round(sheetArea - partsArea);
  var placedCount = finalResults.length;
  // For structured tiling modes, sheetsNeeded is based on the original (pre-expansion) input count.
  // For free mode, use the classic (placed + unplaced) / placed formula.
  var sheetsNeeded;
  if (STRUCTURED_MODES.indexOf(layoutMode) >= 0 && placedCount > 0) {
    sheetsNeeded = origSortedLen > 0 ? Math.ceil(origSortedLen / placedCount) : 1;
  } else {
    sheetsNeeded = placedCount > 0
      ? Math.ceil((placedCount + finalUnplaced.length) / placedCount)
      : (finalUnplaced.length > 0 ? Infinity : 1);
  }

  return { placed: finalResults, unplaced: finalUnplaced, efficiency: efficiency, lossArea: lossArea, sheetsNeeded: sheetsNeeded };
}

self.onmessage = function(e) {
  var polygons = e.data.polygons;
  var sheetConfig = e.data.sheetConfig;
  var lockedParts = e.data.lockedParts || [];
  try {
    var result = nest(polygons, sheetConfig, lockedParts, e.data.setSize || 0);
    self.postMessage({ type: 'result', placed: result.placed, unplaced: result.unplaced, efficiency: result.efficiency, lossArea: result.lossArea, sheetsNeeded: result.sheetsNeeded });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
