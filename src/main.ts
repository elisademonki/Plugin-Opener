import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

const { shell } = require('electron');

type InstalledPluginInfo = {
  folderName: string;
  folderPath: string;
  pluginName: string;
};

type PluginOpenerSettings = {
  showFolderLinksInPluginList: boolean;
};

const DEFAULT_SETTINGS: PluginOpenerSettings = {
  showFolderLinksInPluginList: true,
};

export default class ExterneErweiterungenPlugin extends Plugin {
  settings: PluginOpenerSettings = DEFAULT_SETTINGS;
  private observer: MutationObserver | null = null;
  private refreshTimeout: number | null = null;
  private isRefreshing = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addSettingTab(new PluginOpenerSettingTab(this.app, this));

    this.startSettingsObserver();
    this.scheduleRefreshInjectedLinks();
  }

  onunload(): void {
    this.stopSettingsObserver();
    this.clearScheduledRefresh();
    this.removeInjectedLinks();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getPluginsDir(): string {
    const adapter = this.app.vault.adapter;

    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Dieser Vault verwendet keinen lokalen Dateisystem-Adapter.');
    }

    return path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins');
  }

  getInstalledPlugins(): InstalledPluginInfo[] {
    const pluginsDir = this.getPluginsDir();

    if (!fs.existsSync(pluginsDir)) {
      return [];
    }

    return fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const folderName = entry.name;
        const folderPath = path.join(pluginsDir, folderName);
        const manifestPath = path.join(folderPath, 'manifest.json');

        let pluginName = folderName;

        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string };
            if (typeof manifest.name === 'string' && manifest.name.trim().length > 0) {
              pluginName = manifest.name.trim();
            }
          } catch (error) {
            console.error('[Plugin Opener] manifest.json konnte nicht gelesen werden:', error);
          }
        }

        return {
          folderName,
          folderPath,
          pluginName,
        };
      })
      .sort((a, b) => a.pluginName.localeCompare(b.pluginName, undefined, { sensitivity: 'base' }));
  }

  async openFolderInExplorer(folderPath: string): Promise<void> {
    try {
      const openError = await shell.openPath(path.normalize(folderPath));

      if (openError) {
        new Notice(`Ordner konnte nicht geöffnet werden: ${openError}`);
        return;
      }
    } catch (error) {
      console.error('[Plugin Opener] Ordner konnte nicht geöffnet werden:', error);
      new Notice('Ordner konnte nicht im Explorer geöffnet werden.');
    }
  }

  startSettingsObserver(): void {
    if (this.observer) {
      return;
    }

    this.app.workspace.onLayoutReady(() => {
      this.observer = new MutationObserver((mutations) => {
        if (!this.settings.showFolderLinksInPluginList) {
          return;
        }

        const touchesSettings = mutations.some((mutation) => this.mutationTouchesSettings(mutation));
        if (!touchesSettings) {
          return;
        }

        this.scheduleRefreshInjectedLinks();
      });

      this.observeDocumentBody();
      this.scheduleRefreshInjectedLinks();
    });
  }

  stopSettingsObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  observeDocumentBody(): void {
    if (!this.observer) {
      return;
    }

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  mutationTouchesSettings(mutation: MutationRecord): boolean {
    const target = mutation.target;
    if (target instanceof Element && target.closest('.mod-settings')) {
      return true;
    }

    const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];

    return nodes.some((node) => {
      if (!(node instanceof Element)) {
        return false;
      }

      return node.matches('.mod-settings') || Boolean(node.closest('.mod-settings'));
    });
  }

  scheduleRefreshInjectedLinks(delay = 60): void {
    this.clearScheduledRefresh();

    this.refreshTimeout = window.setTimeout(() => {
      this.refreshTimeout = null;
      this.refreshInjectedLinksSafely();
    }, delay);
  }

  clearScheduledRefresh(): void {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
  }

  refreshInjectedLinksSafely(): void {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    const shouldReconnectObserver = Boolean(this.observer);

    if (shouldReconnectObserver) {
      this.observer?.disconnect();
    }

    try {
      this.refreshInjectedLinks();
    } finally {
      if (shouldReconnectObserver) {
        this.observeDocumentBody();
      }

      this.isRefreshing = false;
    }
  }

  refreshInjectedLinks(): void {
    if (!this.settings.showFolderLinksInPluginList) {
      this.removeInjectedLinks();
      return;
    }

    let plugins: InstalledPluginInfo[] = [];

    try {
      plugins = this.getInstalledPlugins();
    } catch (error) {
      console.error('[Plugin Opener] Plugin-Liste konnte nicht geladen werden:', error);
      return;
    }

    if (plugins.length === 0) {
      this.removeInjectedLinks();
      return;
    }

    const pluginByName = new Map<string, InstalledPluginInfo>();
    const pluginByFolder = new Map<string, InstalledPluginInfo>();

    for (const pluginInfo of plugins) {
      pluginByName.set(this.normalizeText(pluginInfo.pluginName), pluginInfo);
      pluginByFolder.set(this.normalizeText(pluginInfo.folderName), pluginInfo);
    }

    const settingsRoot = document.querySelector('.mod-settings');
    if (!settingsRoot) {
      return;
    }

    const matchedWraps = new Set<HTMLElement>();
    const settingItems = settingsRoot.querySelectorAll<HTMLElement>('.setting-item');

    settingItems.forEach((settingItem) => {
      const nameEl = settingItem.querySelector<HTMLElement>('.setting-item-name');
      if (!nameEl) {
        return;
      }

      const normalizedName = this.getBaseSettingName(nameEl);
      if (!normalizedName) {
        return;
      }

      const pluginInfo = pluginByName.get(normalizedName) ?? pluginByFolder.get(normalizedName);
      if (!pluginInfo) {
        return;
      }

      const inlineWrap = this.ensureInlineLink(nameEl, pluginInfo);
      if (inlineWrap) {
        matchedWraps.add(inlineWrap);
      }
    });

    settingsRoot.querySelectorAll<HTMLElement>('.plugin-opener-inline-wrap').forEach((wrap) => {
      if (!matchedWraps.has(wrap)) {
        wrap.remove();
      }
    });
  }

  ensureInlineLink(nameEl: HTMLElement, pluginInfo: InstalledPluginInfo): HTMLElement | null {
    let inlineWrap = nameEl.querySelector<HTMLElement>('.plugin-opener-inline-wrap');

    if (!inlineWrap) {
      inlineWrap = document.createElement('span');
      inlineWrap.className = 'plugin-opener-inline-wrap';

      const separator = document.createElement('span');
      separator.className = 'plugin-opener-inline-icon';
      separator.textContent = '🔗';

      const linkEl = document.createElement('a');
      linkEl.className = 'plugin-opener-inline-link';
      linkEl.href = '#';

      this.registerDomEvent(linkEl, 'click', async (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const currentTarget = event.currentTarget;
        if (!(currentTarget instanceof HTMLElement)) {
          return;
        }

        const folderPath = currentTarget.dataset.folderPath;
        if (!folderPath) {
          return;
        }

        await this.openFolderInExplorer(folderPath);
      });

      inlineWrap.appendChild(separator);
      inlineWrap.appendChild(linkEl);
      nameEl.appendChild(inlineWrap);
    }

    const linkEl = inlineWrap.querySelector<HTMLAnchorElement>('.plugin-opener-inline-link');
    if (!linkEl) {
      return null;
    }

    linkEl.textContent = pluginInfo.folderName;
    linkEl.title = pluginInfo.folderPath;
    linkEl.dataset.folderPath = pluginInfo.folderPath;
    linkEl.setAttribute('aria-label', `Öffne ${pluginInfo.folderName} im Explorer`);

    return inlineWrap;
  }

  removeInjectedLinks(): void {
    document.querySelectorAll('.plugin-opener-inline-wrap').forEach((element) => element.remove());
  }

  getBaseSettingName(nameEl: HTMLElement): string {
    const clone = nameEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.plugin-opener-inline-wrap').forEach((element) => element.remove());
    return this.normalizeText(clone.textContent ?? '');
  }

  normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }
}

class PluginOpenerSettingTab extends PluginSettingTab {
  plugin: PluginOpenerPlugin;

  constructor(app: App, plugin: PluginOpenerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Ordner-Links neben Plugin-Namen anzeigen')
      .setDesc('Blendet in der normalen Plugin-Liste von Obsidian direkt neben jedem Plugin-Namen einen klickbaren Ordner-Link ein.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showFolderLinksInPluginList)
          .onChange(async (value) => {
            this.plugin.settings.showFolderLinksInPluginList = value;
            await this.plugin.saveSettings();
            this.plugin.refreshInjectedLinksSafely();
          });
      });

    new Setting(containerEl)
      .setName('Links aktualisieren')
      .setDesc('Erneut einlesen und die sichtbaren Ordner-Links sofort neu aufbauen.')
      .addButton((button) => {
        button.setButtonText('Aktualisieren').onClick(() => {
          this.plugin.refreshInjectedLinksSafely();
          new Notice('Ordner-Links wurden aktualisiert.');
        });
      });

    containerEl.createEl('p', {
      text: 'Die Links verwenden den Ordnernamen aus .obsidian/plugins und öffnen den jeweiligen Plugin-Ordner direkt im System-Explorer. Vor dem Ordnernamen wird ein Link-Symbol angezeigt.',
      cls: 'plugin-opener-note',
    });
  }
}
