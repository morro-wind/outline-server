/*
  Copyright 2018 The Outline Authors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import * as digitalocean_server from "../digitalocean_server";
import * as errors from "../../infrastructure/errors";
import * as semver from 'semver';
import * as server from "../../model/server";
import {isManagedServer, Server} from "../../model/server";

import {customElement, html, LitElement, property} from 'lit-element';
import {DisplayServer} from "../display_server";
import {DisplayAccessKey, DisplayDataAmount, ServerView} from "../ui_components/outline-server-view";
import {NotificationManager} from "../app";

const CHANGE_KEYS_PORT_VERSION = '1.0.0';
const DATA_LIMITS_VERSION = '1.1.0';
const CHANGE_HOSTNAME_VERSION = '1.2.0';
const MAX_ACCESS_KEY_DATA_LIMIT_BYTES = 50 * (10 ** 9);  // 50GB

@customElement('manage-server-view')
export class ManageServerView extends LitElement {
  @property({type: Function}) localize: Function;
  @property({type: String}) language: string;
  @property({type: Object}) server: Server;
  @property({type: Object}) displayServer: DisplayServer;
  @property({type: Object}) notificationManager: NotificationManager;

  private serverView: ServerView;

  render() {
    return html`<outline-server-view id="serverView" .localize=${this.localize}></outline-server-view>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.registerEventListeners();
    this.serverView = this.getServerView();
  }

  private registerEventListeners() {
    this.shadowRoot.addEventListener('EnableMetricsRequested', (e: CustomEvent) => this.setMetricsEnabled(true));
    this.shadowRoot.addEventListener('DisableMetricsRequested', (e: CustomEvent) => this.setMetricsEnabled(false));
    this.shadowRoot.addEventListener('ServerRenameRequested', (e: CustomEvent) => this.renameServer(e.detail.newName));
    this.shadowRoot.addEventListener('AddAccessKeyRequested', (e: CustomEvent) => this.addAccessKey());
    this.shadowRoot.addEventListener('RemoveAccessKeyRequested', (e: CustomEvent) => this.removeAccessKey(e.detail.accessKeyId));
    this.shadowRoot.addEventListener('RenameAccessKeyRequested', (e: CustomEvent) => {
      this.renameAccessKey(e.detail.accessKeyId, e.detail.newName, e.detail.entry);
    });
    this.shadowRoot.addEventListener('SetAccessKeyDataLimitRequested', (e: CustomEvent) => {
      this.setAccessKeyDataLimit(ManageServerView.displayDataAmountToDataLimit(e.detail.limit));
    });
    this.shadowRoot.addEventListener('RemoveAccessKeyDataLimitRequested', (e: CustomEvent) => this.removeAccessKeyDataLimit());
    this.shadowRoot.addEventListener('ChangePortForNewAccessKeysRequested', (e: CustomEvent) => {
      this.setPortForNewAccessKeys(e.detail.validatedInput, e.detail.ui);
    });
    this.shadowRoot.addEventListener('ChangeHostnameForAccessKeysRequested', (e: CustomEvent) => {
      this.setHostnameForAccessKeys(e.detail.validatedInput, e.detail.ui);
    });
  }

  // Show the server management screen. Assumes the server is healthy.
  async showServer(server: server.Server, selectedDisplayServer: DisplayServer) {
    this.server = server;
    this.displayServer = selectedDisplayServer;

    // Show view and initialize fields from selectedServer.
    const view = this.getServerView();
    view.isServerReachable = true;
    view.serverId = server.getServerId();
    view.serverName = server.getName();
    view.serverHostname = server.getHostnameForAccessKeys();
    view.serverManagementApiUrl = server.getManagementApiUrl();
    view.serverPortForNewAccessKeys = server.getPortForNewAccessKeys();
    view.serverCreationDate = ManageServerView.localizeDate(server.getCreatedDate(), this.language);
    view.serverVersion = server.getVersion();
    view.accessKeyDataLimit = ManageServerView.dataLimitToDisplayDataAmount(server.getAccessKeyDataLimit());
    view.isAccessKeyDataLimitEnabled = !!view.accessKeyDataLimit;
    view.showFeatureMetricsDisclaimer = server.getMetricsEnabled() &&
        !server.getAccessKeyDataLimit() && !ManageServerView.hasSeenFeatureMetricsNotification();

    const version = server.getVersion();
    if (version) {
      view.isAccessKeyPortEditable = semver.gte(version, CHANGE_KEYS_PORT_VERSION);
      view.supportsAccessKeyDataLimit = semver.gte(version, DATA_LIMITS_VERSION);
      view.isHostnameEditable = semver.gte(version, CHANGE_HOSTNAME_VERSION);
    }

    if (isManagedServer(server)) {
      view.isServerManaged = true;
      const host = server.getHost();
      view.monthlyCost = host.getMonthlyCost().usd;
      view.monthlyOutboundTransferBytes =
          host.getMonthlyOutboundTransferLimit().terabytes * (10 ** 12);
      view.serverLocation = this.getLocalizedCityName(host.getRegionId());
    } else {
      view.isServerManaged = false;
    }

    view.metricsEnabled = server.getMetricsEnabled();
    // this.appRoot.showServerView();
    this.showMetricsOptInWhenNeeded(server, view);

    // Load "My Connection" and other access keys.
    try {
      const serverAccessKeys = await server.listAccessKeys();
      view.accessKeyRows = serverAccessKeys.map(this.convertToUiAccessKey.bind(this));
      if (!view.accessKeyDataLimit) {
        view.accessKeyDataLimit = ManageServerView.dataLimitToDisplayDataAmount(
            await ManageServerView.computeDefaultAccessKeyDataLimit(server, serverAccessKeys));
      }
      // Show help bubbles once the page has rendered.
      setTimeout(() => {
        ManageServerView.showHelpBubblesOnce(view);
      }, 250);
    } catch (error) {
      console.error(`Failed to load access keys: ${error}`);
      this.notificationManager.showError(this.localize('error-keys-get'));
    }

    // this.showTransferStats(server, view);
  }

  private getServerView(): ServerView {
    return this.shadowRoot.querySelector(`#serverView`) as ServerView;
  }

  private async renameServer(newName: string) {
    try {
      await this.server.setName(newName);
      this.serverView.serverName = newName;
    } catch (error) {
      console.error(`Failed to rename server: ${error}`);
      this.notificationManager.showError(this.localize('error-server-rename'));
      const oldName = this.server.getName();
      this.serverView.serverName = oldName;
      // tslint:disable-next-line:no-any
      (this.serverView.$.serverSettings as any).serverName = oldName;
    }

    const params = {
      bubbles: true,
      composed: true,
    };
    const customEvent = new CustomEvent('ServerRenamed', params);
    this.dispatchEvent(customEvent);
  }

  private async setMetricsEnabled(metricsEnabled: boolean) {
    try {
      await this.server.setMetricsEnabled(metricsEnabled);
      this.notificationManager.showNotification(this.localize('saved'));
      // Change metricsEnabled property on polymer element to update display.
      this.serverView.metricsEnabled = metricsEnabled;
    } catch (error) {
      console.error(`Failed to set metrics enabled: ${error}`);
      this.notificationManager.showError(this.localize('error-metrics'));
      this.serverView.metricsEnabled = !metricsEnabled;
    }
  }

  private showMetricsOptInWhenNeeded(selectedServer: server.Server, serverView: ServerView) {
    const showMetricsOptInOnce = () => {
      // Sanity check to make sure the running server is still displayed, i.e.
      // it hasn't been deleted.
      if (this.server !== selectedServer) {
        return;
      }
      // Show the metrics opt in prompt if the server has not already opted in,
      // and if they haven't seen the prompt yet according to localStorage.
      const storageKey = selectedServer.getServerId() + '-prompted-for-metrics';
      if (!selectedServer.getMetricsEnabled() && !localStorage.getItem(storageKey)) {
        // this.appRoot.showMetricsDialogForNewServer();  FIXME:
        localStorage.setItem(storageKey, 'true');
      }
    };

    // Calculate milliseconds passed since server creation.
    const createdDate = selectedServer.getCreatedDate();
    const now = new Date();
    const msSinceCreation = now.getTime() - createdDate.getTime();

    // Show metrics opt-in once ONE_DAY_IN_MS has passed since server creation.
    const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
    if (msSinceCreation >= ONE_DAY_IN_MS) {
      showMetricsOptInOnce();
    } else {
      setTimeout(showMetricsOptInOnce, ONE_DAY_IN_MS - msSinceCreation);
    }
  }

  private async refreshTransferStats(selectedServer: server.Server, serverView: ServerView) {
    try {
      const stats = await selectedServer.getDataUsage();
      let totalBytes = 0;
      // tslint:disable-next-line:forin
      for (const accessKeyId in stats.bytesTransferredByUserId) {
        totalBytes += stats.bytesTransferredByUserId[accessKeyId];
      }
      serverView.setServerTransferredData(totalBytes);

      const accessKeyDataLimit = selectedServer.getAccessKeyDataLimit();
      if (accessKeyDataLimit) {
        // Make access key data usage relative to the data limit.
        totalBytes = accessKeyDataLimit.bytes;
      }

      // Update all the displayed access keys, even if usage didn't change, in case the data limit
      // did.
      for (const accessKey of serverView.accessKeyRows) {
        const accessKeyId = accessKey.id;
        const transferredBytes = stats.bytesTransferredByUserId[accessKeyId] || 0;
        let relativeTraffic =
            totalBytes ? 100 * transferredBytes / totalBytes : (accessKeyDataLimit ? 100 : 0);
        if (relativeTraffic > 100) {
          // Can happen when a data limit is set on an access key that already exceeds it.
          relativeTraffic = 100;
        }
        serverView.updateAccessKeyRow(accessKeyId, {transferredBytes, relativeTraffic});
      }
    } catch (e) {
      // Since failures are invisible to users we generally want exceptions here to bubble
      // up and trigger a Sentry report. The exception is network errors, about which we can't
      // do much (note: ShadowboxServer generates a breadcrumb for failures regardless which
      // will show up when someone explicitly submits feedback).
      if (e instanceof errors.ServerApiError && e.isNetworkError()) {
        return;
      }
      throw e;
    }
  }

  private showTransferStats(selectedServer: server.Server, serverView: ServerView) {
    this.refreshTransferStats(selectedServer, serverView);
    // Get transfer stats once per minute for as long as server is selected.
    const statsRefreshRateMs = 60 * 1000;
    const intervalId = setInterval(() => {
      if (this.server !== selectedServer) {
        // Server is no longer running, stop interval
        clearInterval(intervalId);
        return;
      }
      this.refreshTransferStats(selectedServer, serverView);
    }, statsRefreshRateMs);
  }

  // Converts the access key from the remote service format to the
  // format used by outline-server-view.
  private convertToUiAccessKey(remoteAccessKey: server.AccessKey): DisplayAccessKey {
    return {
      id: remoteAccessKey.id,
      placeholderName: `${this.localize('key', 'keyId', remoteAccessKey.id)}`,
      name: remoteAccessKey.name,
      accessUrl: remoteAccessKey.accessUrl,
      transferredBytes: 0,
      relativeTraffic: 0
    };
  }

  private addAccessKey() {
    this.server.addAccessKey()
        .then((serverAccessKey: server.AccessKey) => {
          const uiAccessKey = this.convertToUiAccessKey(serverAccessKey);
          this.serverView.addAccessKey(uiAccessKey);
          this.notificationManager.showNotification(this.localize('notification-key-added'));
        })
        .catch((error) => {
          console.error(`Failed to add access key: ${error}`);
          this.notificationManager.showError(this.localize('error-key-add'));
        });
  }

  private renameAccessKey(accessKeyId: string, newName: string, entry: polymer.Base) {
    this.server.renameAccessKey(accessKeyId, newName)
        .then(() => entry.commitName())
        .catch((error) => {
          console.error(`Failed to rename access key: ${error}`);
          this.notificationManager.showError(this.localize('error-key-rename'));
          entry.revertName();
        });
  }

  private removeAccessKey(accessKeyId: string) {
    this.server.removeAccessKey(accessKeyId)
        .then(() => {
          this.serverView.removeAccessKey(accessKeyId);
          this.notificationManager.showNotification(this.localize('notification-key-removed'));
        })
        .catch((error) => {
          console.error(`Failed to remove access key: ${error}`);
          this.notificationManager.showError(this.localize('error-key-remove'));
        });
  }

  private async setAccessKeyDataLimit(limit: server.DataLimit) {
    if (!limit) {
      return;
    }
    const previousLimit = this.server.getAccessKeyDataLimit();
    if (previousLimit && limit.bytes === previousLimit.bytes) {
      return;
    }
    try {
      await this.server.setAccessKeyDataLimit(limit);
      this.notificationManager.showNotification(this.localize('saved'));
      this.serverView.accessKeyDataLimit = ManageServerView.dataLimitToDisplayDataAmount(limit);
      this.refreshTransferStats(this.server, this.serverView);
      // Don't display the feature collection disclaimer anymore.
      this.serverView.showFeatureMetricsDisclaimer = false;
      window.localStorage.setItem('dataLimits-feature-collection-notification', 'true');
    } catch (error) {
      console.error(`Failed to set access key data limit: ${error}`);
      this.notificationManager.showError(this.localize('error-set-data-limit'));
      this.serverView.accessKeyDataLimit = ManageServerView.dataLimitToDisplayDataAmount(
          previousLimit || await ManageServerView.computeDefaultAccessKeyDataLimit(this.server));
      this.serverView.isAccessKeyDataLimitEnabled = !!previousLimit;
    }
  }

  private async removeAccessKeyDataLimit() {
    try {
      await this.server.removeAccessKeyDataLimit();
      this.notificationManager.showNotification(this.localize('saved'));
      this.refreshTransferStats(this.server, this.serverView);
    } catch (error) {
      console.error(`Failed to remove access key data limit: ${error}`);
      this.notificationManager.showError(this.localize('error-remove-data-limit'));
      this.serverView.isAccessKeyDataLimitEnabled = true;
    }
  }

  private async setHostnameForAccessKeys(hostname: string, serverSettings: polymer.Base) {
    this.notificationManager.showNotification(this.localize('saving'));
    try {
      await this.server.setHostnameForAccessKeys(hostname);
      this.notificationManager.showNotification(this.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.notificationManager.showError(this.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.localize('error-network'));
        return;
      }
      const message = error.response.status === 400 ? 'error-hostname-invalid' : 'error-unexpected';
      serverSettings.enterErrorState(this.localize(message));
    }
  }

  private async setPortForNewAccessKeys(port: number, serverSettings: polymer.Base) {
    this.notificationManager.showNotification(this.localize('saving'));
    try {
      await this.server.setPortForNewAccessKeys(port);
      this.notificationManager.showNotification(this.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.notificationManager.showError(this.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.localize('error-network'));
        return;
      }
      const code = error.response.status;
      if (code === 409) {
        serverSettings.enterErrorState(this.localize('error-keys-port-in-use'));
        return;
      }
      serverSettings.enterErrorState(this.localize('error-unexpected'));
    }
  }

  private getLocalizedCityName(regionId: server.RegionId) {
    const cityId = digitalocean_server.GetCityId(regionId);
    return this.localize(`city-${cityId}`);
  }

  private static localizeDate(date: Date, language: string): string {
    return date.toLocaleString(language, {year: 'numeric', month: 'long', day: 'numeric'});
  }

  private static async showHelpBubblesOnce(serverView: ServerView) {
    if (!window.localStorage.getItem('addAccessKeyHelpBubble-dismissed')) {
      await serverView.showAddAccessKeyHelpBubble();
      window.localStorage.setItem('addAccessKeyHelpBubble-dismissed', 'true');
    }
    if (!window.localStorage.getItem('getConnectedHelpBubble-dismissed')) {
      await serverView.showGetConnectedHelpBubble();
      window.localStorage.setItem('getConnectedHelpBubble-dismissed', 'true');
    }
    if (!window.localStorage.getItem('dataLimitsHelpBubble-dismissed') &&
        serverView.supportsAccessKeyDataLimit) {
      await serverView.showDataLimitsHelpBubble();
      window.localStorage.setItem('dataLimitsHelpBubble-dismissed', 'true');
    }
  }

  private static dataLimitToDisplayDataAmount(limit: server.DataLimit): DisplayDataAmount|null {
    if (!limit) {
      return null;
    }
    const bytes = limit.bytes;
    if (bytes >= 10 ** 9) {
      return {value: Math.floor(bytes / (10 ** 9)), unit: 'GB'};
    }
    return {value: Math.floor(bytes / (10 ** 6)), unit: 'MB'};
  }

  public static displayDataAmountToDataLimit(dataAmount: DisplayDataAmount): server.DataLimit|null {
    if (!dataAmount) {
      return null;
    }
    if (dataAmount.unit === 'GB') {
      return {bytes: dataAmount.value * (10 ** 9)};
    } else if (dataAmount.unit === 'MB') {
      return {bytes: dataAmount.value * (10 ** 6)};
    }
    return {bytes: dataAmount.value};
  }

  // Compute suggested data limit based on server's transfer capacity and number of access keys.
  private static async computeDefaultAccessKeyDataLimit(
      server: server.Server, accessKeys?: server.AccessKey[]): Promise<server.DataLimit> {
    try {
      // Assume non-managed servers have a data transfer capacity of 1TB.
      let serverTransferCapacity: server.DataAmount = {terabytes: 1};
      if (isManagedServer(server)) {
        serverTransferCapacity = server.getHost().getMonthlyOutboundTransferLimit();
      }
      if (!accessKeys) {
        accessKeys = await server.listAccessKeys();
      }
      let dataLimitBytes = serverTransferCapacity.terabytes * (10 ** 12) / (accessKeys.length || 1);
      if (dataLimitBytes > MAX_ACCESS_KEY_DATA_LIMIT_BYTES) {
        dataLimitBytes = MAX_ACCESS_KEY_DATA_LIMIT_BYTES;
      }
      return {bytes: dataLimitBytes};
    } catch (e) {
      console.error(`Failed to compute default access key data limit: ${e}`);
      return {bytes: MAX_ACCESS_KEY_DATA_LIMIT_BYTES};
    }
  }

  // Returns whether user has seen a notification for the metrics data collection policy.
  private static hasSeenFeatureMetricsNotification(): boolean {
    return !!window.localStorage.getItem('dataLimitsHelpBubble-dismissed') &&
        !!window.localStorage.getItem('dataLimits-feature-collection-notification');
  }
}