/**
 * 技能与插件面板。
 *
 * 这两类扩展此前在侧栏标着「未实现」——但协议其实有完整的 `skills/list`
 * 与 `plugin/list`（共 18 个方法）。标「未实现」是准确的（确实没做），
 * 现在把它做出来。
 *
 * 技能分 `user` 与 `repo` 两个作用域：前者是全局的，后者依赖当前工作区。
 * 这个区分对用户有意义——项目内技能只在该项目生效。
 */
import type { PluginInfo, SkillInfo } from '../types/domain';
import { Icon } from './Icon';

export function SkillList({ skills }: { skills: SkillInfo[] }) {
  if (skills.length === 0) {
    return <p className="panel-empty">当前工作区未发现技能</p>;
  }
  const byScope = skills.reduce<Record<string, SkillInfo[]>>((acc, s) => {
    (acc[s.scope] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="lib-list">
      {Object.entries(byScope).map(([scope, list]) => (
        <div key={scope}>
          <div className="lib-group">
            {scope === 'user' ? '全局技能' : '项目技能'}
            <span className="dim"> ({list.length})</span>
          </div>
          {list.map((s) => (
            <div key={s.path} className={`lib-item ${s.enabled ? '' : 'is-off'}`}>
              <div className="lib-item-head">
                <Icon name="layers" size={12} />
                <span className="lib-name">{s.name}</span>
                {!s.enabled && <span className="chip">已禁用</span>}
              </div>
              <p className="lib-desc">{s.description}</p>
              <div className="lib-path mono" title={s.path}>
                {s.path}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PluginList({ plugins }: { plugins: PluginInfo[] }) {
  if (plugins.length === 0) {
    return <p className="panel-empty">未发现插件市场</p>;
  }
  const byMarket = plugins.reduce<Record<string, PluginInfo[]>>((acc, p) => {
    (acc[p.marketplace] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="lib-list">
      {Object.entries(byMarket).map(([mkt, list]) => (
        <div key={mkt}>
          <div className="lib-group">
            {mkt}
            <span className="dim"> ({list.length})</span>
          </div>
          {list.map((p) => (
            <div key={p.id} className="lib-item">
              <div className="lib-item-head">
                <Icon name="plugin" size={12} />
                <span className="lib-name">{p.name}</span>
                {p.enabled ? (
                  <span className="chip chip-enabled">已启用</span>
                ) : p.installed ? (
                  <span className="chip">已安装</span>
                ) : (
                  <span className="chip chip-available">可用</span>
                )}
              </div>
              {p.description && <p className="lib-desc">{p.description}</p>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
