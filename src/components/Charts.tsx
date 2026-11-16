import type React from "react";

export interface ChartsProps {
  symbol: string;
}

export const Charts: React.FC<ChartsProps> = ({ symbol }) => {
  return (
    <div className="w-full pt-16 bg-[#050811]">
      <div
        id="lightweight-charts-viewport"
        data-symbol={symbol}
        className="h-[calc(100vh-64px)] w-full"
      />
    </div>
  );
};

export default Charts;
