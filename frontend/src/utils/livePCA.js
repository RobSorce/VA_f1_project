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

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0);
  return s;
}
