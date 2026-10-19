import { createApp } from 'vue'
import { createPinia } from 'pinia'

// 按需引入 EP 组件，不做全量注册。
// 图标统一用 RemixIcon（CSS 类名，无 JS 体积），因此不再需要
// @element-plus/icons-vue。
import { ElButton, ElDialog, ElInput, ElOption, ElSelect } from 'element-plus'

import './style.css'
import App from './App.vue'
import router from './router'

// 只引用到组件的样式（theme-chalk 分文件），不引全量 index.css。
// 顺序：base 最前，它定义 --el-* 变量与 reset。
//
// 注意 el-message.css 必须引入：ElMessage 是命令式调用（在 stores 里
// toast()），模板里看不到它，很容易在"按需引入"时漏掉。漏了它的后果
// 不是样式变丑，而是消息条没有 position:fixed，直接掉进文档流卡在
// 页面底部，看起来像个去不掉的弹窗。
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-select.css'
import 'element-plus/theme-chalk/el-message.css'
// el-dialog：配置页的编辑弹窗。漏引会让弹窗失去遮罩与定位，
// 直接展开在文档流里——和之前漏 el-message 是同一类坑。
import 'element-plus/theme-chalk/el-dialog.css'
import 'element-plus/theme-chalk/el-overlay.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.component('ElButton', ElButton)
app.component('ElDialog', ElDialog)
app.component('ElInput', ElInput)
app.component('ElOption', ElOption)
app.component('ElSelect', ElSelect)

app.mount('#app')
