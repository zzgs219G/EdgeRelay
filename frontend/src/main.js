import { createApp } from 'vue'
import { createPinia } from 'pinia'
// 按需引入，不做 app.use(ElementPlus) 全量注册。
// 全量引入会把整个 EP 打进 bundle（gzip 后 ~390KB），移动端首屏白屏
// 好几秒。这里只注册真正用到的 4 个组件 + 用到的图标。
import {
  ElButton, ElIcon, ElInput, ElOption, ElSelect,
} from 'element-plus'

import './style.css'
import App from './App.vue'
import router from './router'
// 只引这 4 个组件的样式，不引 element-plus/dist/index.css（那是全量
// 60+ 组件的样式，~370KB）。顺序：base 在最前（reset + 变量），
// 组件样式依赖它定义的 --el-* 变量。
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-select.css'
import 'element-plus/theme-chalk/el-icon.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.component('ElButton', ElButton)
app.component('ElIcon', ElIcon)
app.component('ElInput', ElInput)
app.component('ElOption', ElOption)
app.component('ElSelect', ElSelect)

app.mount('#app')
