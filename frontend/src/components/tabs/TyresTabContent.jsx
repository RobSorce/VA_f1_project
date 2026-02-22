import React from 'react';
import TyreHealth from '../visualizations/TyreHealth';
import TyreManagement from '../visualizations/TyreManagement';

export default function TyresTabContent() {
  return (
    <div className="tyres-tab">
      <div className="tyres-tab__health">
        <TyreHealth />
      </div>
      <div className="tyres-tab__management">
        <TyreManagement />
      </div>
    </div>
  );
}
