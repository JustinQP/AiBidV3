import type { BidFile, ExportRecord, OutlineSection, Requirement, ReviewIssue } from '../types'

export const project = {
  id: 'demo',
  name: '智慧园区数字化平台建设项目',
  code: 'ZHYQ-2026-017',
  tenderNo: 'GZTC-2026-0421',
  purchaser: '城投数字科技有限公司',
  owner: '张伟',
  deadline: '2026-07-22 09:30',
  package: '01 包：平台软件与实施服务',
  secrecy: '机密',
  budget: '1,280 万元',
}

export const initialFiles: BidFile[] = [
  { id: 'f1', name: '智慧园区数字化平台招标文件.pdf', category: '招标正文', size: '18.6 MB', pages: 286, version: 'V1', status: 'ready', updatedAt: '07-10 09:42', owner: '张伟' },
  { id: 'f2', name: '附件1_技术需求书.docx', category: '技术附件', size: '3.2 MB', pages: 64, version: 'V2', status: 'ready', updatedAt: '07-10 09:44', owner: '李明' },
  { id: 'f3', name: '附件2_评分办法.xlsx', category: '评分附件', size: '860 KB', pages: '4 个工作表', version: 'V1', status: 'ready', updatedAt: '07-10 09:45', owner: '张伟' },
  { id: 'f4', name: '附件3_资质证明扫描件.pdf', category: '资格附件', size: '26.8 MB', pages: 42, version: 'V1', status: 'error', updatedAt: '07-10 09:46', owner: '王芳' },
]

export const initialRequirements: Requirement[] = [
  { id: 'REQ-018', type: '技术要求', summary: '平台应采用微服务架构，支持平台弹性扩展与独立升级。', source: '附件1_技术需求书.docx', page: 12, mandatory: true, confidence: 98, owner: '李明', section: '3.2 总体技术方案', risk: '低', status: '编写中', confirmed: true },
  { id: 'REQ-024', type: '评分项', summary: '总体技术架构合理、先进、完整，最高得 8 分。', source: '附件2_评分办法.xlsx', page: 2, score: 8, mandatory: false, confidence: 96, owner: '李明', section: '3.2 总体技术方案', risk: '中', status: '编写中', confirmed: true },
  { id: 'REQ-031', type: '技术要求', summary: '数据安全须满足分级保护、传输加密与全流程审计要求。', source: '智慧园区数字化平台招标文件.pdf', page: 87, mandatory: true, confidence: 99, owner: '王芳', section: '3.4 数据架构设计', risk: '高', status: '待响应', confirmed: true },
  { id: 'REQ-047', type: '评分项', summary: '提供不少于 3 个同类智慧园区平台项目案例。', source: '附件2_评分办法.xlsx', page: 3, score: 6, mandatory: false, confidence: 93, owner: '陈晨', section: '5.2 类似项目案例', risk: '中', status: '待响应', confirmed: true },
  { id: 'REQ-063', type: '资格项', summary: '项目经理应具备高级信息系统项目管理师资格。', source: '智慧园区数字化平台招标文件.pdf', page: 32, mandatory: true, confidence: 97, owner: '赵敏', section: '4.1 项目组织与人员', risk: '低', status: '已响应', confirmed: true },
  { id: 'REQ-078', type: '商务要求', summary: '项目整体建设周期不得超过合同签订后 180 日历天。', source: '智慧园区数字化平台招标文件.pdf', page: 24, mandatory: true, confidence: 91, owner: '周宁', section: '4.3 项目实施计划', risk: '中', status: '已确认', confirmed: true },
  { id: 'REQ-091', type: '无效条款', summary: '未按要求提供原厂授权函将导致投标无效。', source: '智慧园区数字化平台招标文件.pdf', page: 19, mandatory: true, confidence: 88, owner: '王芳', section: '6.3 授权与承诺', risk: '阻断', status: '待响应', confirmed: false },
  { id: 'REQ-105', type: '评分项', summary: '驻场运维方案应包含服务组织、响应时限与应急预案。', source: '附件2_评分办法.xlsx', page: 4, score: 5, mandatory: false, confidence: 72, owner: '未分配', section: '未映射', risk: '高', status: '未确认', confirmed: false },
]

export const initialOutline: OutlineSection[] = [
  { id: 's1', number: '1', title: '项目理解与整体方案', level: 1, owner: '李明', reviewer: '张伟', targetWords: 8000, requirementCount: 12, status: '已批准' },
  { id: 's2', number: '2', title: '建设方案', level: 1, owner: '李明', reviewer: '张伟', targetWords: 18000, requirementCount: 32, status: '编写中' },
  { id: 's21', number: '2.1', title: '总体架构设计', level: 2, owner: '李明', reviewer: '张伟', targetWords: 4500, requirementCount: 8, status: '已批准' },
  { id: 's22', number: '2.2', title: '平台功能设计', level: 2, owner: '李明', reviewer: '张伟', targetWords: 6000, requirementCount: 16, status: '编写中' },
  { id: 's3', number: '3', title: '技术方案', level: 1, owner: '李明', reviewer: '张伟', targetWords: 22000, requirementCount: 18, status: '编写中' },
  { id: 's31', number: '3.1', title: '总体技术路线', level: 2, owner: '李明', reviewer: '张伟', targetWords: 3200, requirementCount: 4, status: '已批准' },
  { id: 's32', number: '3.2', title: '总体技术方案', level: 2, owner: '李明', reviewer: '张伟', targetWords: 5200, requirementCount: 12, status: '编写中' },
  { id: 's33', number: '3.3', title: '平台功能设计', level: 2, owner: '陈晨', reviewer: '张伟', targetWords: 8000, requirementCount: 20, status: '编写中' },
  { id: 's34', number: '3.4', title: '数据架构设计', level: 2, owner: '王芳', reviewer: '张伟', targetWords: 4800, requirementCount: 9, status: '待审核' },
  { id: 's4', number: '4', title: '实施计划', level: 1, owner: '周宁', reviewer: '张伟', targetWords: 12000, requirementCount: 15, status: '未开始' },
]

export const initialIssues: ReviewIssue[] = [
  { id: 'ISS-008', title: '数据安全要求未完整响应', description: 'REQ-031 中的数据脱敏要求尚未在正文中体现。', severity: '阻断', owner: '王芳', location: '3.2.3 数据安全设计', status: '待处理' },
  { id: 'ISS-012', title: '同类案例数量不足', description: '当前仅引用 2 个案例，招标要求不少于 3 个。', severity: '重要', owner: '陈晨', location: '5.2 类似项目案例', status: '待处理' },
  { id: 'ISS-017', title: '项目名称表述不一致', description: '本章出现“智慧园区平台项目”简称，建议统一正式名称。', severity: '一般', owner: '李明', location: '3.2 总体技术方案', status: '已解决' },
]

export const initialExports: ExportRecord[] = [
  { id: 'EXP-001', name: '智慧园区数字化平台建设项目_技术标_草稿V3.docx', type: '草稿', template: '企业技术标标准模板 V2.3', contentVersion: 'V0.8.3', createdAt: '2026-07-09 21:18', owner: '张伟', size: '18.4 MB' },
]

export const recentProjects = [
  { id: 'demo', name: project.name, code: project.code, purchaser: project.purchaser, owner: '张伟', deadline: '07-22 09:30', stage: '协同编写', progress: 68, coverage: 95.5, risks: 7 },
  { id: 'p2', name: '城市运行管理服务平台升级项目', code: 'CSYX-2026-012', purchaser: '市大数据中心', owner: '赵敏', deadline: '07-29 14:00', stage: '智能解析', progress: 32, coverage: 76.8, risks: 12 },
  { id: 'p3', name: '国企数据中台建设与治理项目', code: 'SJZT-2026-006', purchaser: '华南产业集团', owner: '王芳', deadline: '08-05 10:00', stage: '目录规划', progress: 48, coverage: 88.2, risks: 4 },
]
