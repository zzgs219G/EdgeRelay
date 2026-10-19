import { createApp } from 'vue'
import { createPinia } from 'pinia'

// 按需引入 EP 组件，不做全量注册。
// 图标统一用 RemixIcon（CSS 类名，无 JS 体积），因此不再需要
// @element-plus/icons-vue。
import { ElButton, ElInput, ElOption, ElSelect } from 'element-plus'

import './style.css'
import App from './App.vue'
import router from './router'

// 只引用到组件的样式（theme-chalk 分文件），不引全量 index.css。
// 顺序：base 最前，它定义 --el-* 变量与 reset。
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-select.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.component('ElButton', ElButton)
app.component('ElInput', ElInput)
app.component('ElOption', ElOption)
app.component('ElSelect', ElSelect)

app.mount('#app')
