import { ClusterFunMessageBase } from "../ClusterFunMessage.js";

export interface ClusterFunMessageConstructor<P, M extends ClusterFunMessageBase> {
    readonly messageTypeName: string;
    new (payload: P): M;
};