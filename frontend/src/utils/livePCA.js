/**
 * Client-side PCA for small matrices (~20 drivers x 7 features), the Race
 * Situation Map. Uses the Jacobi eigenvalue algorithm on the covariance matrix
 * of the standardized features.
 *
 * Refitted at every lap (computePCA): the current means / SDs and the current
 * eigenvectors, so the axis labels give the variance the axes capture at that
 * lap and the origin is the current field mean. Lap-to-lap continuity comes
 * from aligning the new eigenvectors to the previous lap's, feature by feature
 * (LIVE_PCA_ALIGN: an in-plane orthogonal Procrustes rotation; the sign-only
 * mode on request), applied to the points and to the loading arrows alike.
 */

/**
 * Alignment of the live PCA (the store's computeRaceSituation, the default of
 * computePCA): 'rotation', the orthogonal Procrustes turn of this lap's PC1-PC2
 * plane onto the previous lap's axes. A sign-only alignment cannot undo the
 * in-plane turn (or the PC1 / PC2 swap) of two close eigenvalues, so the map
 * jumped; the rotation keeps the axes inside the same plane and moves the
 * points less from lap to lap (scripts/live_pca_compare.mjs section 3,
 * scripts/pca_repair_check.mjs).
 */
export const LIVE_PCA_ALIGN = 'rotation';

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
 * Cap on Jacobi rotations per matrix entry (jacobiEigen). Not data: a bound
 * well above the rotations the method needs to bring every off-diagonal entry
 * below 1e-10; scripts/live_pca_compare.mjs reports the eigen-residual
 * max |C v - lambda v| reached on every lap.
 */
const JACOBI_ROTATIONS_PER_ENTRY = 50;

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
 * @param {number} [maxIter] - rotations; default JACOBI_ROTATIONS_PER_ENTRY x M^2
 *   (one rotation zeroes one off-diagonal pair; the loop stops earlier once every
 *   off-diagonal entry is below 1e-10)
 * @returns {{ eigenvalues: number[], eigenvectors: number[][] }}
 */
export function jacobiEigen(A, maxIter = JACOBI_ROTATIONS_PER_ENTRY * A.length * A.length) {
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
 * Full PCA pipeline at one lap: standardize with the current means / SDs →
 * covariance → eigen → top 2 PCs, aligned to the previous lap's basis →
 * project.
 *
 * Alignment (`prevResult`, the previous lap's result on the same features):
 *  - 'sign': each eigenvector's sign only (its dot with the previous lap's
 *    displayed axis >= 0); the axes stay the principal axes, so axis 1 is PC1
 *    and its label the eigenvalue share.
 *  - 'rotation' (default, LIVE_PCA_ALIGN, the store's): the orthogonal 2x2
 *    matrix R that minimises
 *    ||W R - B||_F, W = this lap's [ev1 ev2] and B = the previous lap's
 *    displayed basis, both feature-ordered M x 2 (orthogonal Procrustes:
 *    W^T B = U S V^T, R = U V^T; a reflection is allowed, a PC's sign being
 *    arbitrary). The displayed basis W R spans the same PC1-PC2 plane, so the
 *    two axes together capture the variance of PC1 + PC2; each axis's share
 *    is reported as it is (explainedVariance), not as the eigenvalue's.
 *    diag((W R)^T B) = diag(V S V^T) >= 0: no displayed axis points against
 *    the previous one. Smaller lap-to-lap moves, but the axes drift away
 *    from PC1 / PC2 (scripts/live_pca_compare.mjs, section 3).
 * The same displayed basis gives the scores and the loading arrows, so the
 * points and the arrows always agree (a point is sum_j z_j x arrow_j).
 *
 * @param {number[][]} matrix - NxM raw data (N drivers, M features)
 * @param {string[]} featureNames - M feature labels
 * @param {object|null} prevResult - the previous lap's computePCA result (alignment
 *   reference); ignored when its features differ
 * @param {{ align?: 'rotation'|'sign'|'none' }} [opts]
 * @returns {{ scores: {x,y}[], loadings: {feature,pc1,pc2}[], explainedVariance: [number,number],
 *   eigenShare: [number,number], basis: number[][], featureNames: string[], means: number[],
 *   stds: number[], totalVar: number, eigenResidual: number,
 *   alignment: { mode: string, dots: [number,number], rotationDeg: number, reflected: boolean,
 *     residual: number }|null } | null}
 *   scores: centred on the current field mean (the origin); loadings: the displayed
 *   basis per feature, sorted by combined magnitude; explainedVariance: the share of
 *   the total variance each displayed axis captures at this lap; eigenShare: lambda1 /
 *   total and lambda2 / total; basis: displayed basis, feature-ordered (unsorted) M x 2;
 *   alignment.dots: displayed axis k . previous axis k; residual: ||W R - B||_F
 */
export function computePCA(matrix, featureNames, prevResult = null, { align = LIVE_PCA_ALIGN } = {}) {
  if (!matrix || matrix.length < 3 || !matrix[0]?.length) return null;
  const M = matrix[0].length;

  const { standardized, means, stds } = standardize(matrix);
  const cov = covarianceMatrix(standardized);
  // Total variance of the standardized data = number of non-constant columns
  let totalVar = 0;
  for (let j = 0; j < M; j++) totalVar += cov[j][j];
  if (totalVar < 1e-10) return null;

  const { eigenvalues, eigenvectors } = jacobiEigen(cov);
  const ev1 = eigenvectors[0];
  const ev2 = eigenvectors[1];
  let basis = Array.from({ length: M }, (_, j) => [ev1[j], ev2[j]]);

  // Align to the previous lap's displayed basis, feature by feature (never to
  // its loadings list, which is sorted by magnitude)
  const prevBasis = sameFeatures(prevResult, featureNames) ? prevResult.basis : null;
  let alignment = null;
  if (prevBasis && align !== 'none') {
    let R;
    if (align === 'sign') {
      const s1 = columnDot(basis, prevBasis, 0) < 0 ? -1 : 1;
      const s2 = columnDot(basis, prevBasis, 1) < 0 ? -1 : 1;
      R = [[s1, 0], [0, s2]];
    } else {
      R = orthogonalProcrustes(basis, prevBasis);
    }
    basis = basis.map(([a, b]) => [a * R[0][0] + b * R[1][0], a * R[0][1] + b * R[1][1]]);
    let residual = 0;
    for (let j = 0; j < M; j++) {
      residual += (basis[j][0] - prevBasis[j][0]) ** 2 + (basis[j][1] - prevBasis[j][1]) ** 2;
    }
    const detR = R[0][0] * R[1][1] - R[0][1] * R[1][0];
    alignment = {
      mode: align,
      dots: [columnDot(basis, prevBasis, 0), columnDot(basis, prevBasis, 1)],
      // in-plane angle of R (of R x diag(1, -1) when R is a reflection)
      rotationDeg: Math.atan2(R[1][0], R[0][0]) * 180 / Math.PI,
      reflected: detR < 0,
      residual: Math.sqrt(residual),
    };
  }

  // Project: scores = X_std * basis
  const scores = standardized.map((z) => {
    let x = 0;
    let y = 0;
    for (let j = 0; j < M; j++) {
      x += z[j] * basis[j][0];
      y += z[j] * basis[j][1];
    }
    return { x, y };
  });

  // Variance each displayed axis captures: b^T C b / total
  const captured = [0, 1].map((k) => {
    let q = 0;
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < M; j++) q += basis[i][k] * cov[i][j] * basis[j][k];
    }
    return q / totalVar;
  });

  // Loadings = displayed basis per feature; a sorted copy for the views
  const loadings = featureNames.map((name, j) => ({
    feature: name,
    pc1: basis[j][0],
    pc2: basis[j][1],
  }));
  loadings.sort((a, b) => (b.pc1 ** 2 + b.pc2 ** 2) - (a.pc1 ** 2 + a.pc2 ** 2));

  return {
    scores,
    loadings,
    explainedVariance: captured,
    eigenShare: [eigenvalues[0] / totalVar, eigenvalues[1] / totalVar],
    basis,
    featureNames: [...featureNames],
    means,
    stds,
    totalVar,
    eigenResidual: Math.max(eigenResidual(cov, ev1, eigenvalues[0]), eigenResidual(cov, ev2, eigenvalues[1])),
    alignment,
  };
}

/** True when `prev` is a computePCA result with a basis on the same features. */
function sameFeatures(prev, featureNames) {
  const names = prev?.featureNames;
  return Array.isArray(prev?.basis) && Array.isArray(names) && names.length === featureNames.length
    && names.every((n, i) => n === featureNames[i]);
}

/** Column k of A . column k of B (both M x 2). */
function columnDot(A, B, k) {
  let s = 0;
  for (let j = 0; j < A.length; j++) s += A[j][k] * B[j][k];
  return s;
}

/** max_i |(C v)_i - lambda v_i|. */
function eigenResidual(C, v, lambda) {
  let worst = 0;
  for (let i = 0; i < C.length; i++) {
    let cv = 0;
    for (let j = 0; j < C.length; j++) cv += C[i][j] * v[j];
    worst = Math.max(worst, Math.abs(cv - lambda * v[i]));
  }
  return worst;
}

/**
 * Orthogonal Procrustes for M x 2 bases: the orthogonal 2x2 R minimising
 * ||A R - B||_F, R = U V^T for A^T B = U S V^T (reflection allowed).
 *
 * @param {number[][]} A - M x 2
 * @param {number[][]} B - M x 2
 * @returns {number[][]} 2x2
 */
export function orthogonalProcrustes(A, B) {
  let k00 = 0, k01 = 0, k10 = 0, k11 = 0;
  for (let j = 0; j < A.length; j++) {
    k00 += A[j][0] * B[j][0];
    k01 += A[j][0] * B[j][1];
    k10 += A[j][1] * B[j][0];
    k11 += A[j][1] * B[j][1];
  }
  const { U, V } = svd2x2(k00, k01, k10, k11);
  return [
    [U[0][0] * V[0][0] + U[0][1] * V[0][1], U[0][0] * V[1][0] + U[0][1] * V[1][1]],
    [U[1][0] * V[0][0] + U[1][1] * V[0][1], U[1][0] * V[1][0] + U[1][1] * V[1][1]],
  ];
}

/**
 * Procrustes alignment in 2D: the rotation (no reflection) and scale that best
 * map the matched `newPts` onto `refPts` (least squares), applied to every
 * point of `allNewScores`.
 *
 * Column-vector convention: aligned = s x R x (p - c_new) + c_ref, with c_new /
 * c_ref the centroids of the matched points, H = sum (ref_i - c_ref)(new_i - c_new)^T
 * = ref^T new (2x2), H = U S V^T and R = U V^T (R = U diag(1, -1) V^T when
 * det(U V^T) < 0, to stay a rotation). A cloud rotated by theta is rotated back
 * by -theta (scripts/live_pca_compare.mjs, section 1).
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

  // 5. Rotation R = U * V^T; a pure rotation is wanted (no reflection), so
  //    when det(R) < 0 the second singular direction is flipped
  let r00 = U[0][0] * V[0][0] + U[0][1] * V[0][1];
  let r01 = U[0][0] * V[1][0] + U[0][1] * V[1][1];
  let r10 = U[1][0] * V[0][0] + U[1][1] * V[0][1];
  let r11 = U[1][0] * V[1][0] + U[1][1] * V[1][1];

  const detR = r00 * r11 - r01 * r10;
  if (detR < 0) {
    r00 = U[0][0] * V[0][0] - U[0][1] * V[0][1];
    r01 = U[0][0] * V[1][0] - U[0][1] * V[1][1];
    r10 = U[1][0] * V[0][0] - U[1][1] * V[0][1];
    r11 = U[1][0] * V[1][0] - U[1][1] * V[1][1];
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

  // 7. Apply transformation to ALL new scores: result = s * R * (pt - newCentroid) + refCentroid,
  //    the centroids of the matched points (the least-squares translation)
  return allNewScores.map((pt) => {
    const cx = pt.x - newCx;
    const cy = pt.y - newCy;
    return {
      x: clampedScale * (r00 * cx + r01 * cy) + refCx,
      y: clampedScale * (r10 * cx + r11 * cy) + refCy,
    };
  });
}

/**
 * Analytic SVD for 2x2 matrix [[a,b],[c,d]].
 * Returns U and V as 2x2 arrays (both orthogonal, also when the matrix has
 * rank 1 or 0).
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
  } else {
    // Rank <= 1: any unit vector orthogonal to the first column completes U
    U[0][1] = -U[1][0];
    U[1][1] = U[0][0];
  }

  return { U, V, s1, s2 };
}
