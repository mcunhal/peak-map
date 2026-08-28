// Vue's runtime-only build is used, so the root component is mounted with a render
// function rather than a string template (which would need the compiler build).
import Vue from 'vue';
import App from './App.vue';

Vue.config.productionTip = false;

new Vue({
  el: '#app',
  render: (h) => h(App),
});
