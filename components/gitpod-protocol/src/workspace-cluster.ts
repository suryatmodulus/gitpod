/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import * as fs from 'fs';
import { filePathTelepresenceAware } from './env';
import { DeepPartial } from "./util/deep-partial";
import { Without } from './util/without';

export interface WorkspaceCluster {
    // Name of the workspace cluster.
    // This is the string set in each 
    // Must be identical to the installationShortname of the cluster it represents!
    name: string;

    // URL of the cluster's ws-manager API
    url: string;

    // TLS contains the keys and certificates necessary to use mTLS between server and clients
    tls?: TLSConfig;

    // Current state of the cluster
    state: WorkspaceClusterState;

    // Maximum value score can reach for this cluster
    maxScore: number;

    // Score used for cluster selection when starting workspace instances
    score: number;

    // True if this bridge should control this cluster
    govern: boolean;
}
export type WorkspaceClusterState = "available" | "cordoned" | "draining";
export interface TLSConfig {
    // the CA shared between client and server (base64 encoded)
    ca: string;
    // the private key (base64 encoded)
    key: string;
    // the certificate signed with the shared CA (base64 encoded)
    crt: string;
}
export namespace TLSConfig {
    export const loadFromBase64File = (path: string): string => fs.readFileSync(filePathTelepresenceAware(path)).toString("base64");
}
export type WorkspaceClusterWoTls = Without<WorkspaceCluster, "tls">;
export type WorkspaceManagerConnectionInfo = Pick<WorkspaceCluster, "name" | "url" | "tls">;

export const WorkspaceClusterDB = Symbol("WorkspaceClusterDB");
export interface WorkspaceClusterDB {
    /**
     * Stores the given WorkspaceCluster to the cluster-local DB in a consistent manner.
     * If there already is an entry with the same name it's merged and updated with the given state.
     * @param cluster 
     */
    save(cluster: WorkspaceCluster): Promise<void>;

    /**
     * Deletes the cluster identified by this name, if any.
     * @param name 
     */
    deleteByName(name: string): Promise<void>;

    /**
     * Finds a WorkspaceCluster with the given name. If there is none, `undefined` is returned.
     * @param name 
     */
    findByName(name: string): Promise<WorkspaceCluster | undefined>;

    /**
     * Lists all WorkspaceClusterWoTls for which the given predicate is true (does not return TLS for size/speed concerns)
     * @param predicate 
     */
    findFiltered(predicate: DeepPartial<WorkspaceClusterFilter>): Promise<WorkspaceClusterWoTls[]>;
}
export interface WorkspaceClusterFilter extends Pick<WorkspaceCluster, "state" | "govern" | "url"> {
    minScore: number;
}