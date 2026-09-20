/**
 * 欢迎页。对齐 Codex 的形态：
 *
 * ```
 *           ⊙（图标）
 *    你想让我们在 proteus 中构建什么?
 *
 *  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 *  │ 探索理解 │ │ 构建新功能│ │ 审查代码 │ │ 修复问题 │
 *  └────────┘ └────────┘ └────────┘ └────────┘
 * ```
 *
 * # 为什么值得做
 *
 * 空态是最容易被忽略、也最容易劝退用户的地方。一个只有「暂无内容」
 * 的空面板不告诉用户能做什么；给出四个典型任务入口，用户不必先学会
 * 怎么提问。这些提示词本身也是产品的功能说明。
 */
import { Icon } from './Icon';

type IconName = Parameters<typeof Icon>[0]['name'];

interface Suggestion {
  icon: IconName;
  title: string;
  prompt: string;
}

/** 四个建议任务。提示词直接可提交——不是装饰性文案。 */
const SUGGESTIONS: Suggestion[] = [
  {
    icon: 'compass',
    title: '探索并理解代码',
    prompt: '浏览这个项目，说明它的整体结构、主要模块与关键技术选型。',
  },
  {
    icon: 'sparkle',
    title: '构建新功能或工具',
    prompt: '先介绍项目现有的代码风格与约定，然后等我描述要构建的功能。',
  },
  {
    icon: 'edit',
    title: '审查代码并提出修改建议',
    prompt: '审查当前工作区未提交的改动，指出问题并给出具体修改建议。',
  },
  {
    icon: 'wrench',
    title: '修复问题和失败',
    prompt: '运行项目的测试与构建，找出失败项并修复它们。',
  },
];

export function Welcome({
  projectName,
  onPick,
}: {
  projectName: string;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-emblem">
        <Icon name="sparkle" size={30} />
      </div>
      <h1 className="welcome-title">
        你想让我们在 <span className="welcome-project">{projectName}</span> 中构建什么?
      </h1>
      <div className="welcome-cards">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            className="welcome-card"
            onClick={() => onPick(s.prompt)}
            title={s.prompt}
          >
            <span className="welcome-card-icon">
              <Icon name={s.icon} size={20} />
            </span>
            <span className="welcome-card-title">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
