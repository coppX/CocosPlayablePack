import { _decorator, Component, Node } from 'cc';
const { ccclass, property } = _decorator;
declare const PlayableSDK: any;
@ccclass('HelloWorld')
export class HelloWorld extends Component {
    start() {
        if (typeof PlayableSDK !== 'undefined') {
            PlayableSDK.ready();
            PlayableSDK.track('start');
        }
    }

    update(deltaTime: number) {
        
    }

    // 点击 CTA 按钮
    onClickCTA () {
    if (typeof PlayableSDK !== 'undefined') {
        PlayableSDK.open(); // 或 PlayableSDK.open('https://your-store-url')
    }
    }
}


