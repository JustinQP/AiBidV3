import { ArrowRight, Building2, Clock3, FileStack, ShieldCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, PageHeader } from '../components/ui'

const content: Record<string, { title: string; description: string; icon: typeof Building2; items: string[] }> = {
  workspace: { title: '工作台', description: '集中查看投标任务、项目提醒和跨项目动态。', icon: Clock3, items: ['我的待办 8 项', '临近截标项目 3 个', '失败任务 1 个'] },
  knowledge: { title: '企业知识库', description: '管理公司资质、案例、人员与解决方案资料。', icon: FileStack, items: ['已发布资料 1,286 份', '30 天内到期 12 份', '待审核资料 6 份'] },
  templates: { title: '模板中心', description: '统一管理企业投标书模板、样式和封面字段。', icon: FileStack, items: ['已发布模板 8 套', '草稿模板 3 套', '待校验模板 1 套'] },
  tasks: { title: '任务中心', description: '查看解析、生成、检查和导出等异步任务。', icon: Clock3, items: ['运行中 3 个', '今日完成 46 个', '可重试 1 个'] },
  admin: { title: '企业管理', description: '组织、用户、模型、安全与审计的企业级治理入口。', icon: ShieldCheck, items: ['组织成员 126 人', '启用模型 4 个', '今日审计事件 328 条'] },
  settings: { title: '项目设置', description: '维护项目基础信息、成员权限、模板和归档策略。', icon: Building2, items: ['项目成员 8 人', '章节编写人 5 人', '审核人 2 人'] },
}

export function PlaceholderPage({ type }: { type: keyof typeof content }) {
  const navigate = useNavigate()
  const config = content[type]
  const Icon = config.icon
  return (
    <div className="page page-placeholder">
      <PageHeader title={config.title} description={config.description} />
      <section className="placeholder-hero">
        <div className="placeholder-icon"><Icon size={30} /></div>
        <div>
          <h2>{config.title}已纳入完整信息架构</h2>
          <p>当前高保真原型优先演示投标项目主闭环。此入口保留企业版产品边界，并展示可继续扩展的真实模块骨架。</p>
        </div>
        <Button onClick={() => navigate('/projects/demo/overview')} icon={<ArrowRight size={16} />}>进入演示项目</Button>
      </section>
      <div className="placeholder-metrics">
        {config.items.map((item) => <div key={item}><strong>{item.split(' ')[1]}</strong><span>{item.split(' ')[0]}</span></div>)}
      </div>
    </div>
  )
}
