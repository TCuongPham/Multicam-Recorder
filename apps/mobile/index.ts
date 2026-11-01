// Định nghĩa tác vụ nền phải nằm ở phạm vi module, trước khi đăng ký component gốc.
import './src/services/background';
import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
