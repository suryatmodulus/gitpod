/**
 * Copyright (c) 2025 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { FC } from "react";
import Alert from "../components/Alert";
import { useMaintenanceNotification } from "../data/maintenance-mode/maintenance-notification-query";
import { useMaintenanceMode } from "../data/maintenance-mode/maintenance-mode-query";
import { DEFAULT_MESSAGE } from "./MaintenanceNotificationCard";

export const MaintenanceNotificationBanner: FC = () => {
    const { isNotificationEnabled, notificationMessage } = useMaintenanceNotification();
    const { isMaintenanceMode } = useMaintenanceMode();

    // if both maintenance mode and scheduled notification are enabled,
    // only show the maintenance mode notification
    if (isMaintenanceMode || !isNotificationEnabled) {
        return null;
    }

    const displayMessage = notificationMessage || DEFAULT_MESSAGE;

    return (
        <Alert type="warning" className="mb-2">
            <div className="flex items-center">
                <span className="font-semibold">Scheduled Maintenance:</span>
                <span className="ml-2">{displayMessage}</span>
            </div>
        </Alert>
    );
};
