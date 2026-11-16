declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

declare namespace React {
  export type FC<P = {}> = (props: P & { key?: string | number }) => any;
  export type ReactNode = any;
  export type ChangeEvent<T = any> = {
    target: T;
  };
}

declare module "react" {
  export = React;
}

declare module "@react-three/fiber" {
  export const Canvas: any;
  export function useFrame(cb: (state: any, delta: number) => void): void;
}

declare module "@react-three/postprocessing" {
  export const EffectComposer: any;
  export const Bloom: any;
  export const N8AO: any;
}
