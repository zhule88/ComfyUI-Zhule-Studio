import random


class ZhuleProbability:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "forceInput": True}),
                "probability": ("INT", {"default": 50, "min": 0, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ("STRING", "BOOLEAN")
    RETURN_NAMES = ("text", "passed")
    FUNCTION = "process"
    CATEGORY = "Zhule"

    def process(self, text, probability):
        roll = random.randint(0, 99)
        passed = roll < probability

        print(f"[ZhuleProbability] 概率={probability}%, 掷骰={roll}, 结果={'通过' if passed else '跳过'}")

        if passed:
            return (text, True)
        return ("", False)