from .nodes.action_set import ZhuleActionSet
from .nodes.pass_gate import ZhulePass
from .nodes.probability_gate import ZhuleProbability
from .nodes.picker import ZhulePicker


NODE_CLASS_MAPPINGS = {
    "ZhuleActionSet": ActionSet,
    "ZhulePass": ZhulePass,
    "ZhuleProbability": ZhuleProbability,
    "ZhulePicker": ZhulePicker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ZhuleActionSet": "ZhuleActionSet",
    "ZhulePass": "ZhulePass",
    "ZhuleProbability": "ZhuleProbability",
    "ZhulePicker": "ZhulePicker",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]