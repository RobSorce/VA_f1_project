import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import TSNEScatterplot from '../visualizations/TSNEScatterplot';
import PCABiplot from '../visualizations/PCABiplot';
import RaceSituationMap from '../visualizations/RaceSituationMap';
import StrategyAnalysis from '../visualizations/StrategyAnalysis';

export default function AnalyticsTabContent() {
  const projectionMode = useF1Store((s) => s.projectionMode);
  const setProjectionMode = useF1Store((s) => s.setProjectionMode);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);

  return (
    <div className="analytics-tab">
      <div className="analytics-tab__scatterplot">
        <div className="analytics-tab__toggle">
          {!isQualifyingReplay && (
            <button
              className={`analytics-tab__toggle-btn${projectionMode === 'live' ? ' analytics-tab__toggle-btn--live active' : ''}`}
              onClick={() => setProjectionMode('live')}
              title="Live race situation PCA (current race only)"
            >
              LIVE
            </button>
          )}
          <button
            className={`analytics-tab__toggle-btn${projectionMode === 'tsne' ? ' active' : ''}`}
            onClick={() => setProjectionMode('tsne')}
          >
            t-SNE
          </button>
          <button
            className={`analytics-tab__toggle-btn${projectionMode === 'pca' ? ' active' : ''}`}
            onClick={() => setProjectionMode('pca')}
          >
            PCA
          </button>
        </div>
        {projectionMode === 'live' && !isQualifyingReplay ? (
          <RaceSituationMap />
        ) : projectionMode === 'pca' ? (
          <PCABiplot />
        ) : (
          <TSNEScatterplot />
        )}
      </div>
      <div className="analytics-tab__analysis">
        <StrategyAnalysis />
      </div>
    </div>
  );
}
