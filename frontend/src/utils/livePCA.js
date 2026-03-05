/**
 * Client-side PCA for small matrices (~20 drivers x 10 features).
 * Uses Jacobi eigenvalue algorithm on the covariance matrix.
 */

/**
 * Standardize a matrix column-wise (zero mean, unit variance).
 * @param {number[][]} matrix - NxM array
 * @returns {{ standardized: number[][], means: number[], stds: number[] }}
 */
export function standardize(matrix) {
  const N = matrix.length;
  const M = matrix[0].length;
  const means = new Array(M).fill(0);
  const stds = new Array(M).fill(0);

  // Column means
  for (let j = 0; j < M; j++) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += matrix[i][j];
    means[j] = sum / N;
  }

  // Column stds
  for (let j = 0; j < M; j++) {
    let ssq = 0;
    for (let i = 0; i < N; i++) ssq += (matrix[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(ssq / (N - 1));
    if (stds[j] < 1e-10) stds[j] = 1; // constant column — avoid division by zero
  }

  // Standardize
  const standardized = matrix.map((row) =>
    row.map((val, j) => (val - means[j]) / stds[j])
  );

  return { standardized, means, stds };
}

/**
 * Compute covariance matrix from a standardized NxM matrix.
 * @param {number[][]} X - NxM standardized data
 * @returns {number[][]} MxM covariance matrix
 */
export function covarianceMatrix(X) {
  const N = X.length;
  const M = X[0].length;
  const cov = Array.from({ length: M }, () => new Array(M).fill(0));

  for (let i = 0; i < M; i++) {
    for (let j = i; j < M; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) sum += X[k][i] * X[k][j];
      const val = sum / (N - 1);
      cov[i][j] = val;
      cov[j][i] = val;
    }
  }
  return cov;
}

/**
 * Jacobi eigenvalue algorithm for symmetric matrices.
 * Returns eigenvalues (descending) and corresponding eigenvectors.
 * @param {number[][]} A - MxM symmetric matrix
 * @param {number} maxIter
 * @returns {{ eigenvalues: number[], eigenvectors: number[][] }}
 */
export function jacobiEigen(A, maxIter = 100) {
  const M = A.length;
  // Work on a copy
  const S = A.map((row) => [...row]);
  // Eigenvectors start as identity
  const V = Array.from({ length: M }, (_, i) => {
    const row = new Array(M).fill(0);
    row[i] = 1;
    return row;
  });

  for (let iter = 0; iter < maxIter; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < M; i++) {
      for (let j = i + 1; j < M; j++) {
        if (Math.abs(S[i][j]) > maxVal) {
          maxVal = Math.abs(S[i][j]);
          p = i;
          q = j;
        }
      }
    }

    // Check convergence
    if (maxVal < 1e-10) break;

    // Compute rotation angle
    const theta =
      Math.abs(S[p][p] - S[q][q]) < 1e-15
        ? Math.PI / 4
        : 0.5 * Math.atan2(2 * S[p][q], S[p][p] - S[q][q]);

    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // Apply Givens rotation to S
    const Spp = c * c * S[p][p] + 2 * s * c * S[p][q] + s * s * S[q][q];
    const Sqq = s * s * S[p][p] - 2 * s * c * S[p][q] + c * c * S[q][q];

    S[p][p] = Spp;
    S[q][q] = Sqq;
    S[p][q] = 0;
    S[q][p] = 0;

    for (let i = 0; i < M; i++) {
      if (i === p || i === q) continue;
      const Sip = c * S[i][p] + s * S[i][q];
      const Siq = -s * S[i][p] + c * S[i][q];
      S[i][p] = Sip;
      S[p][i] = Sip;
      S[i][q] = Siq;
      S[q][i] = Siq;
    }

    // Accumulate eigenvectors
    for (let i = 0; i < M; i++) {
      const Vip = c * V[i][p] + s * V[i][q];
      const Viq = -s * V[i][p] + c * V[i][q];
      V[i][p] = Vip;
      V[i][q] = Viq;
    }
  }

  // Extract eigenvalues and sort descending
  const eigenvalues = [];
  for (let i = 0; i < M; i++) eigenvalues.push(S[i][i]);

  const indices = eigenvalues.map((_, i) => i).sort((a, b) => eigenvalues[b] - eigenvalues[a]);

  return {
    eigenvalues: indices.map((i) => eigenvalues[i]),
    eigenvectors: indices.map((i) => V.map((row) => row[i])), // each eigenvector is a column → M values
  };
}

/**
 * Full PCA pipeline: standardize → covariance → eigen → project onto top 2 PCs.
 * @param {number[][]} matrix - NxM raw data (N drivers, M features)
 * @param {string[]} featureNames - M feature labels
 * @param {object|null} prevResult - previous PCA result for sign consistency
 * @returns {{ scores: {x,y}[], loadings: {feature,pc1,pc2}[], explainedVariance: [number,number] } | null}
 */
export function computePCA(matrix, featureNames, prevResult = null) {
  if (!matrix || matrix.length < 3 || !matrix[0]?.length) return null;

  const { standardized } = standardize(matrix);
  const cov = covarianceMatrix(standardized);
  const { eigenvalues, eigenvectors } = jacobiEigen(cov);

  const totalVar = eigenvalues.reduce((a, b) => a + Math.max(0, b), 0);
  if (totalVar < 1e-10) return null;

  let ev1 = eigenvectors[0]; // top eigenvector (M values)
  let ev2 = eigenvectors[1];

  // Sign consistency: if previous result exists, align signs
  if (prevResult?.loadings?.length) {
    const prevPC1 = prevResult.loadings.map((l) => l.pc1);
    const prevPC2 = prevResult.loadings.map((l) => l.pc2);
    if (dot(ev1, prevPC1) < 0) ev1 = ev1.map((v) => -v);
    if (dot(ev2, prevPC2) < 0) ev2 = ev2.map((v) => -v);
  }

  // Project: scores = X_std * [ev1, ev2]
  const N = standardized.length;
  const scores = [];
  for (let i = 0; i < N; i++) {
    let x = 0;
    let y = 0;
    for (let j = 0; j < standardized[i].length; j++) {
      x += standardized[i][j] * ev1[j];
      y += standardized[i][j] * ev2[j];
    }
    scores.push({ x, y });
  }

  // Loadings = eigenvector components
  const loadings = featureNames.map((name, j) => ({
    feature: name,
    pc1: ev1[j],
    pc2: ev2[j],
  }));

  // Sort loadings by combined magnitude
  loadings.sort((a, b) => (b.pc1 ** 2 + b.pc2 ** 2) - (a.pc1 ** 2 + a.pc2 ** 2));

  const explainedVariance = [
    eigenvalues[0] / totalVar,
    eigenvalues[1] / totalVar,
  ];

  return { scores, loadings, explainedVariance };
}

/**
 * Procrustes alignment in 2D: find optimal rotation (+ optional reflection)
 * to align `newPts` to `refPts` using matched point pairs.
 * Returns the transformation applied to ALL newScores (not just matched ones).
 *
 * @param {{ x: number, y: number }[]} refPts - reference points (previous frame, matched subset)
 * @param {{ x: number, y: number }[]} newPts - new points (current frame, matched subset)
 * @param {{ x: number, y: number }[]} allNewScores - all current scores to transform
 * @returns {{ x: number, y: number }[]} - transformed scores
 */
export function procrustesAlign2D(refPts, newPts, allNewScores) {
  const n = refPts.length;
  if (n < 3) return allNewScores; // need at least 3 matched drivers

  // 1. Compute centroids
  let refCx = 0, refCy = 0, newCx = 0, newCy = 0;
  for (let i = 0; i < n; i++) {
    refCx += refPts[i].x; refCy += refPts[i].y;
    newCx += newPts[i].x; newCy += newPts[i].y;
  }
  refCx /= n; refCy /= n;
  newCx /= n; newCy /= n;

  // 2. Center both sets
  const refC = refPts.map((p) => ({ x: p.x - refCx, y: p.y - refCy }));
  const newC = newPts.map((p) => ({ x: p.x - newCx, y: p.y - newCy }));

  // 3. Cross-covariance matrix H (2x2) = ref^T * new
  let h00 = 0, h01 = 0, h10 = 0, h11 = 0;
  for (let i = 0; i < n; i++) {
    h00 += refC[i].x * newC[i].x;
    h01 += refC[i].x * newC[i].y;
    h10 += refC[i].y * newC[i].x;
    h11 += refC[i].y * newC[i].y;
  }

  // 4. SVD of 2x2: H = U * S * V^T
  //    For 2x2, use analytic SVD
  const { U, V } = svd2x2(h00, h01, h10, h11);

  // 5. Rotation R = V * U^T  (allows reflection if det < 0)
  //    We want pure rotation (no reflection), so correct if det(R) < 0
  let r00 = V[0][0] * U[0][0] + V[0][1] * U[0][1];
  let r01 = V[0][0] * U[1][0] + V[0][1] * U[1][1];
  let r10 = V[1][0] * U[0][0] + V[1][1] * U[0][1];
  let r11 = V[1][0] * U[1][0] + V[1][1] * U[1][1];

  const detR = r00 * r11 - r01 * r10;
  if (detR < 0) {
    // Flip the second column of V
    r00 = -V[0][1] * U[0][0] + V[0][0] * U[0][1];
    r01 = -V[0][1] * U[1][0] + V[0][0] * U[1][1];
    r10 = -V[1][1] * U[0][0] + V[1][0] * U[0][1];
    r11 = -V[1][1] * U[1][0] + V[1][0] * U[1][1];
  }

  // 6. Compute scale: s = trace(S_corrected) / sum(||newC||^2)
  let newSumSq = 0;
  for (let i = 0; i < n; i++) {
    newSumSq += newC[i].x ** 2 + newC[i].y ** 2;
  }
  // trace(ref^T * R * new) — numerator for scale
  let traceRS = 0;
  for (let i = 0; i < n; i++) {
    const rx = r00 * newC[i].x + r01 * newC[i].y;
    const ry = r10 * newC[i].x + r11 * newC[i].y;
    traceRS += refC[i].x * rx + refC[i].y * ry;
  }
  const scale = newSumSq > 1e-10 ? traceRS / newSumSq : 1;

  // Clamp scale to reasonable range to avoid extreme zooms
  const clampedScale = Math.max(0.5, Math.min(2.0, scale));

  // 7. Apply transformation to ALL new scores: result = s * R * (pt - newCentroid) + refCentroid
  // Use centroids of ALL new scores for centering
  let allCx = 0, allCy = 0;
  for (const s of allNewScores) { allCx += s.x; allCy += s.y; }
  allCx /= allNewScores.length; allCy /= allNewScores.length;

  return allNewScores.map((pt) => {
    const cx = pt.x - allCx;
    const cy = pt.y - allCy;
    return {
      x: clampedScale * (r00 * cx + r01 * cy) + refCx,
      y: clampedScale * (r10 * cx + r11 * cy) + refCy,
    };
  });
}

/**
 * Analytic SVD for 2x2 matrix [[a,b],[c,d]].
 * Returns U and V as 2x2 arrays.
 */
function svd2x2(a, b, c, d) {
  // A^T A
  const ata00 = a * a + c * c;
  const ata01 = a * b + c * d;
  const ata11 = b * b + d * d;

  // Eigenvalues of A^T A via quadratic
  const sum = ata00 + ata11;
  const diff = ata00 - ata11;
  const disc = Math.sqrt(diff * diff + 4 * ata01 * ata01);
  const s1sq = Math.max(0, (sum + disc) / 2);
  const s2sq = Math.max(0, (sum - disc) / 2);

  // Eigenvectors of A^T A → columns of V
  const theta = 0.5 * Math.atan2(2 * ata01, diff);
  const V = [
    [Math.cos(theta), -Math.sin(theta)],
    [Math.sin(theta), Math.cos(theta)],
  ];

  // Singular values
  const s1 = Math.sqrt(s1sq);
  const s2 = Math.sqrt(s2sq);

  // U = A * V * S^-1
  const U = [[1, 0], [0, 1]];
  if (s1 > 1e-10) {
    U[0][0] = (a * V[0][0] + b * V[1][0]) / s1;
    U[1][0] = (c * V[0][0] + d * V[1][0]) / s1;
  }
  if (s2 > 1e-10) {
    U[0][1] = (a * V[0][1] + b * V[1][1]) / s2;
    U[1][1] = (c * V[0][1] + d * V[1][1]) / s2;
  }

  return { U, V, s1, s2 };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0);
  return s;
}
