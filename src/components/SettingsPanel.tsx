/**
 * 设置面板。
 *
 * 展示**实际生效**的配置，而不是我们以为的默认值：
 * 每一项都来自 `config/read`，包含配置文件路径——用户需要知道
 * 界面上的开关到底改的是哪个文件，否则「为什么我的配置没生效」
 * 这类问题无从排查。
 *
 * 尚未接入的项**不显示**，而不是画一个点不动的控件。界面上的
 * 死开关比缺失更糟：用户会反复点，然后怀疑整个应用。
 */
import { Icon } from './Icon';
import { PermissionPicker } from './PermissionPicker';
import type { SettingsSnapshot } from '../types/domain';
import type { ModelOption } from '../types/domain';

export function SettingsPanel({
  settings,
  models,
  selectedModel,
  onSelectModel,
  onSelectMode,
  onReload,
}: {
  settings: SettingsSnapshot | null;
  models: ModelOption[];
  selectedModel: string | null;
  onSelectModel: (id: string) => void;
  onSelectMode: (mode: SettingsSnapshot['mode']) => void;
  onReload: () => void;
}) {
  if (!settings) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="cpu" size={13} />
          <span>设置</span>
        </div>
        <p className="panel-empty">正在读取配置…</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="cpu" size={13} />
        <span>设置</span>
        <button className="mini-btn" onClick={onReload} title="重新读取配置">
          刷新
        </button>
      </div>

      <div className="settings-body">
        {/* 权限：复用输入区同一个组件，保证两处显示与行为一致 */}
        <div className="settings-row">
          <div className="settings-label">
            <span>权限</span>
            <span className="settings-hint">沙箱范围与审批策略</span>
          </div>
          <PermissionPicker current={settings.mode} onSelect={onSelectMode} />
        </div>

        {/* 模型：来自 model/list，由 provider 提供 */}
        <div className="settings-row">
          <div className="settings-label">
            <span>模型</span>
            <span className="settings-hint">
              {models.length > 0 ? `共 ${models.length} 个可用` : '未读到模型列表'}
            </span>
          </div>
          {models.length > 0 ? (
            <label className="settings-select">
              <select
                value={selectedModel ?? ''}
                onChange={(e) => onSelectModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="settings-value dim">—</span>
          )}
        </div>

        {/* 服务商：只读展示。切换 provider 需要改 base_url / 凭据，
            不是一个下拉能安全表达的，这里如实显示当前值而不给假控件。 */}
        <div className="settings-row">
          <div className="settings-label">
            <span>服务商</span>
            <span className="settings-hint">来自 config.toml</span>
          </div>
          <span className="settings-value mono">
            {settings.modelProvider ?? '(默认)'}
            {settings.providers.length > 0 && (
              <span className="settings-sub">
                已配置 {settings.providers.join(' · ')}
              </span>
            )}
          </span>
        </div>

        {settings.configPath && (
          <div className="settings-row">
            <div className="settings-label">
              <span>配置文件</span>
              <span className="settings-hint">改动写入此处</span>
            </div>
            <span className="settings-value mono path">{settings.configPath}</span>
          </div>
        )}
      </div>
    </div>
  );
}
